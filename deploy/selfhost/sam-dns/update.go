package main

import (
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/miekg/dns"
)

// challengePrefix is the only first label an update may write (RFC 8555 section 8.4).
const challengePrefix = "_acme-challenge."

// Challenges holds the ACME DNS-01 TXT records Caddy writes over the loopback update channel. They
// live in memory only and never reach D1: a challenge lasts seconds, and a box restart mid-order
// just makes Caddy retry.
type Challenges struct {
	mu        sync.RWMutex
	values    map[string]map[string]challengeValue // name -> joined TXT strings -> value
	ttl       uint32
	maxAge    time.Duration
	maxNames  int
	maxValues int
	now       func() time.Time
}

type challengeValue struct {
	txt   []string
	added time.Time
}

func NewChallenges(cfg *Config) *Challenges {
	return &Challenges{
		values:    map[string]map[string]challengeValue{},
		ttl:       cfg.ChallengeTTL,
		maxAge:    cfg.ChallengeMaxAge,
		maxNames:  cfg.MaxChallengeNames,
		maxValues: cfg.MaxChallengeValues,
		now:       time.Now,
	}
}

func txtKey(txt []string) string { return strings.Join(txt, "\x00") }

// pruneLocked drops values older than maxAge (a challenge nobody deleted).
func (c *Challenges) pruneLocked() {
	cutoff := c.now().Add(-c.maxAge)
	for name, values := range c.values {
		for key, v := range values {
			if v.added.Before(cutoff) {
				delete(values, key)
			}
		}
		if len(values) == 0 {
			delete(c.values, name)
		}
	}
}

// Values is the TXT RRset served for name (nil when there is none). Safe on a nil receiver.
// Read-only: expired values are skipped here and pruned by apply, so queries never take the write
// lock (one read lock per lookup).
func (c *Challenges) Values(name string) []dns.RR {
	if c == nil {
		return nil
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.values) == 0 {
		return nil
	}
	cutoff := c.now().Add(-c.maxAge)
	var out []dns.RR
	for _, v := range c.values[name] {
		if v.added.Before(cutoff) {
			continue
		}
		out = append(out, &dns.TXT{Hdr: rrHeader(name, dns.TypeTXT, c.ttl), Txt: append([]string(nil), v.txt...)})
	}
	return out
}

type challengeOp struct {
	name   string
	add    bool
	txt    []string // nil with !add: delete every value at name
	byName bool     // delete the whole name (class ANY, type ANY)
}

// isChallengeName: `_acme-challenge.<anything>` strictly inside the zone.
func isChallengeName(name, zone string) bool {
	return strings.HasPrefix(name, challengePrefix) && dns.IsSubDomain(zone, name) && name != zone
}

// parseUpdate checks every RR of the update section before anything is applied (RFC 2136
// section 3.4: all or nothing). Only TXT records under _acme-challenge may be added or removed.
func parseUpdate(r *dns.Msg, zone string) ([]challengeOp, bool) {
	var ops []challengeOp
	for _, rr := range r.Ns {
		h := rr.Header()
		name := dns.CanonicalName(h.Name)
		if !isChallengeName(name, zone) {
			return nil, false
		}
		switch {
		case h.Class == dns.ClassINET && h.Rrtype == dns.TypeTXT:
			txt, ok := rr.(*dns.TXT)
			if !ok || len(txt.Txt) == 0 || len(txtKey(txt.Txt)) > 255 {
				return nil, false
			}
			ops = append(ops, challengeOp{name: name, add: true, txt: txt.Txt})
		case h.Class == dns.ClassNONE && h.Rrtype == dns.TypeTXT:
			txt, ok := rr.(*dns.TXT)
			if !ok || len(txt.Txt) == 0 { // a value delete needs the value
				return nil, false
			}
			ops = append(ops, challengeOp{name: name, txt: txt.Txt})
		case h.Class == dns.ClassANY && h.Rrtype == dns.TypeTXT:
			ops = append(ops, challengeOp{name: name})
		case h.Class == dns.ClassANY && h.Rrtype == dns.TypeANY:
			ops = append(ops, challengeOp{name: name, byName: true})
		default:
			return nil, false
		}
	}
	return ops, len(ops) > 0
}

// apply runs the operations as one unit; false (nothing changed) when the bounds would be crossed.
func (c *Challenges) apply(ops []challengeOp) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pruneLocked()
	next := map[string]map[string]challengeValue{}
	for name, values := range c.values {
		next[name] = map[string]challengeValue{}
		for k, v := range values {
			next[name][k] = v
		}
	}
	now := c.now()
	for _, op := range ops {
		switch {
		case op.add:
			if next[op.name] == nil {
				next[op.name] = map[string]challengeValue{}
			}
			next[op.name][txtKey(op.txt)] = challengeValue{txt: append([]string(nil), op.txt...), added: now}
		case op.byName || op.txt == nil:
			delete(next, op.name)
		default:
			delete(next[op.name], txtKey(op.txt))
		}
		if len(next[op.name]) == 0 {
			delete(next, op.name)
		}
	}
	if len(next) > c.maxNames {
		return false
	}
	for _, values := range next {
		if len(values) > c.maxValues {
			return false
		}
	}
	c.values = next
	return true
}

// handleUpdate answers an RFC 2136 UPDATE on the loopback listener. It must carry a valid TSIG
// (HMAC-SHA256) signed with the configured key; the miekg/dns server has already verified the MAC
// and reports the outcome in w.TsigStatus().
func (h *Handler) handleUpdate(w dns.ResponseWriter, r *dns.Msg) {
	reply := new(dns.Msg)
	reply.SetReply(r)
	tsig := r.IsTsig()
	// The fudge is the client's: cap it, so a captured update cannot be replayed for hours.
	if tsig == nil || w.TsigStatus() != nil ||
		dns.CanonicalName(tsig.Hdr.Name) != h.cfg.TSIGKeyName ||
		!strings.EqualFold(tsig.Algorithm, dns.HmacSHA256) || tsig.Fudge > DefaultTSIGFudge {
		slog.Warn("sam-dns: update refused: missing or invalid TSIG", "action", "rejected")
		reply.Rcode = dns.RcodeNotAuth
		_ = w.WriteMsg(reply) // unsigned: we cannot sign for a key we did not verify
		return
	}
	reply.SetTsig(h.cfg.TSIGKeyName, dns.HmacSHA256, DefaultTSIGFudge, time.Now().Unix())
	zone := r.Question[0]
	switch {
	case zone.Qtype != dns.TypeSOA || zone.Qclass != dns.ClassINET || dns.CanonicalName(zone.Name) != h.cfg.Zone:
		reply.Rcode = dns.RcodeNotAuth // not our zone
	default:
		ops, ok := parseUpdate(r, h.cfg.Zone)
		if !ok {
			slog.Warn("sam-dns: update refused: only _acme-challenge TXT records may change", "action", "rejected")
			reply.Rcode = dns.RcodeRefused
		} else if !h.challenges.apply(ops) {
			slog.Warn("sam-dns: update refused: challenge store bound reached", "action", "rejected")
			reply.Rcode = dns.RcodeRefused
		} else {
			slog.Info("sam-dns: challenge records updated", "operations", len(ops))
		}
	}
	_ = w.WriteMsg(reply)
}

// updateAcceptFunc admits UPDATE on the loopback listener only: one zone, no prerequisites, a
// bounded update section and the TSIG in the additional section.
func updateAcceptFunc(dh dns.Header) dns.MsgAcceptAction {
	if dh.Bits&(1<<15) != 0 { // a response
		return dns.MsgIgnore
	}
	opcode := int(dh.Bits>>11) & 0xF
	switch opcode {
	case dns.OpcodeQuery:
		return dns.DefaultMsgAcceptFunc(dh)
	case dns.OpcodeUpdate:
		if dh.Qdcount != 1 || dh.Ancount != 0 || dh.Nscount == 0 || dh.Nscount > 64 || dh.Arcount > 2 {
			return dns.MsgReject
		}
		return dns.MsgAccept
	default:
		return dns.MsgRejectNotImplemented
	}
}
