package main

import (
	"fmt"
	"log/slog"
	"net"
	"strings"

	"github.com/miekg/dns"
)

// SyncedRecord is one record the Worker keeps in D1 (apps/api/src/selfhost/dns/records.ts).
type SyncedRecord struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Content string `json:"content"`
}

// Zone is one immutable snapshot of the box's zone: the static records (SOA, NS, glue, the
// *.SAM_DOMAIN wildcard to the box) plus the records synced from D1. A sync builds a new Zone and
// swaps it in whole, so a query never sees half of an update.
type Zone struct {
	apex    string                         // FQDN, lowercase
	serial  uint32                         // the D1 zone serial this snapshot was built from
	records map[string]map[uint16][]dns.RR // owner name -> type -> RRset
	// Empty non-terminals: names with no records but with records below them (apps.<apex> when
	// r1-...apps.<apex> exists). They stop the apex wildcard from matching below them (RFC 4592).
	ents     map[string]bool
	wildcard map[uint16][]dns.RR // the *.<apex> RRsets, owner "*.<apex>"
	soa      *dns.SOA
	negTTL   uint32
}

func rrHeader(name string, rrtype uint16, ttl uint32) dns.RR_Header {
	return dns.RR_Header{Name: name, Rrtype: rrtype, Class: dns.ClassINET, Ttl: ttl}
}

func addressRRs(name string, cfg *Config) []dns.RR {
	out := []dns.RR{&dns.A{Hdr: rrHeader(name, dns.TypeA, cfg.TTL), A: cfg.PublicIPv4}}
	if cfg.PublicIPv6 != nil {
		out = append(out, &dns.AAAA{Hdr: rrHeader(name, dns.TypeAAAA, cfg.TTL), AAAA: cfg.PublicIPv6})
	}
	return out
}

// nameServer is the box's own name server name; its glue goes in the parent zone.
func nameServer(cfg *Config) string { return "ns1." + cfg.Zone }

// reservedOwner reports whether a synced record may not use this name: the static names, the
// wildcard owner, and the ACME challenge names, which only the TSIG update channel writes.
func reservedOwner(name string, cfg *Config) bool {
	if name == cfg.Zone || name == nameServer(cfg) || strings.HasPrefix(name, "*.") {
		return true
	}
	return strings.HasPrefix(name, "_acme-challenge.")
}

// BuildZone makes a snapshot from the config and the synced records. A record that is malformed
// or outside the zone is skipped and logged, never fatal (one bad row must not drop the zone).
func BuildZone(cfg *Config, serial uint32, synced []SyncedRecord) (*Zone, int) {
	if serial == 0 {
		serial = 1
	}
	z := &Zone{
		apex:     cfg.Zone,
		serial:   serial,
		records:  map[string]map[uint16][]dns.RR{},
		ents:     map[string]bool{},
		wildcard: map[uint16][]dns.RR{},
		negTTL:   cfg.NegativeTTL,
	}
	z.soa = &dns.SOA{
		Hdr:     rrHeader(cfg.Zone, dns.TypeSOA, cfg.TTL),
		Ns:      nameServer(cfg),
		Mbox:    "hostmaster." + cfg.Zone,
		Serial:  serial,
		Refresh: 3600,
		Retry:   600,
		Expire:  1209600,
		Minttl:  cfg.NegativeTTL,
	}
	z.add(z.soa)
	z.add(&dns.NS{Hdr: rrHeader(cfg.Zone, dns.TypeNS, cfg.TTL), Ns: nameServer(cfg)})
	for _, rr := range addressRRs(nameServer(cfg), cfg) {
		z.add(rr)
	}
	for _, rr := range addressRRs("*."+cfg.Zone, cfg) {
		z.wildcard[rr.Header().Rrtype] = append(z.wildcard[rr.Header().Rrtype], rr)
	}

	skipped := 0
	for _, record := range synced {
		rr, err := syncedRR(record, cfg)
		if err != nil {
			skipped++
			slog.Warn("sam-dns: synced record skipped", "name", truncate(record.Name, 255),
				"type", truncate(record.Type, 16), "error", err.Error(), "action", "skipped")
			continue
		}
		z.add(rr)
	}
	for name := range z.records {
		for parent := parentName(name); parent != "" && parent != z.apex; parent = parentName(parent) {
			if _, ok := z.records[parent]; !ok {
				z.ents[parent] = true
			}
		}
	}
	return z, skipped
}

func syncedRR(record SyncedRecord, cfg *Config) (dns.RR, error) {
	name := dns.CanonicalName(record.Name)
	if _, ok := dns.IsDomainName(name); !ok || !dns.IsSubDomain(cfg.Zone, name) || name == cfg.Zone {
		return nil, fmt.Errorf("not a name below the zone")
	}
	if reservedOwner(name, cfg) {
		return nil, fmt.Errorf("a reserved name")
	}
	if record.Type != "A" {
		return nil, fmt.Errorf("unsupported type")
	}
	ip := net.ParseIP(record.Content).To4()
	if ip == nil {
		return nil, fmt.Errorf("not an IPv4 address")
	}
	return &dns.A{Hdr: rrHeader(name, dns.TypeA, cfg.TTL), A: ip}, nil
}

func (z *Zone) add(rr dns.RR) {
	h := rr.Header()
	if z.records[h.Name] == nil {
		z.records[h.Name] = map[uint16][]dns.RR{}
	}
	z.records[h.Name][h.Rrtype] = append(z.records[h.Name][h.Rrtype], rr)
}

// RecordCount is the number of synced and static owner names, for logs.
func (z *Zone) RecordCount() int { return len(z.records) }

func parentName(name string) string {
	i := strings.IndexByte(name, '.')
	if i < 0 || i == len(name)-1 {
		return ""
	}
	return name[i+1:]
}

// Answer is what a lookup produced: the rcode and the three sections.
type Answer struct {
	Rcode     int
	Answer    []dns.RR
	Authority []dns.RR
}

func copyRRs(rrs []dns.RR, owner string) []dns.RR {
	out := make([]dns.RR, 0, len(rrs))
	for _, rr := range rrs {
		c := dns.Copy(rr)
		c.Header().Name = owner
		out = append(out, c)
	}
	return out
}

func (z *Zone) negative(rcode int) Answer {
	soa := dns.Copy(z.soa).(*dns.SOA)
	if z.negTTL < soa.Hdr.Ttl {
		soa.Hdr.Ttl = z.negTTL // RFC 2308 section 3: the lesser of the SOA TTL and minimum
	}
	return Answer{Rcode: rcode, Authority: []dns.RR{soa}}
}

// rfc8482 is the minimal answer to ANY (RFC 8482 section 4.2): one synthesized HINFO.
func rfc8482(owner string, ttl uint32) []dns.RR {
	return []dns.RR{&dns.HINFO{Hdr: rrHeader(owner, dns.TypeHINFO, ttl), Cpu: "RFC8482", Os: ""}}
}

// Lookup answers one question authoritatively. Out-of-zone names are REFUSED: this server never
// recurses and never answers for another zone.
func (z *Zone) Lookup(qname string, qtype uint16, challenges *Challenges) Answer {
	q := dns.CanonicalName(qname)
	if !dns.IsSubDomain(z.apex, q) {
		return Answer{Rcode: dns.RcodeRefused}
	}
	node := z.records[q]
	txt := challenges.Values(q)
	if node != nil || len(txt) > 0 || z.ents[q] || challenges.HasBelow(q) {
		if qtype == dns.TypeANY {
			return Answer{Rcode: dns.RcodeSuccess, Answer: rfc8482(q, z.soa.Hdr.Ttl)}
		}
		answer := copyRRs(node[qtype], q)
		if qtype == dns.TypeTXT {
			answer = append(answer, txt...)
		}
		if len(answer) == 0 {
			return z.negative(dns.RcodeSuccess) // NODATA
		}
		return Answer{Rcode: dns.RcodeSuccess, Answer: answer}
	}
	// No such node: find the closest encloser. Only the apex has a wildcard child, so the name is
	// synthesized from *.<apex> exactly when nothing between the name and the apex exists.
	encloser := parentName(q)
	for encloser != z.apex && encloser != "" {
		if _, ok := z.records[encloser]; ok || z.ents[encloser] || challenges.HasBelow(encloser) ||
			len(challenges.Values(encloser)) > 0 {
			return z.negative(dns.RcodeNameError)
		}
		encloser = parentName(encloser)
	}
	if qtype == dns.TypeANY {
		return Answer{Rcode: dns.RcodeSuccess, Answer: rfc8482(q, z.soa.Hdr.Ttl)}
	}
	if rrs := z.wildcard[qtype]; len(rrs) > 0 {
		return Answer{Rcode: dns.RcodeSuccess, Answer: copyRRs(rrs, q)}
	}
	return z.negative(dns.RcodeSuccess)
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
