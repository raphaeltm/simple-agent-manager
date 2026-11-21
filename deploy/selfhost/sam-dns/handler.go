package main

import (
	"net"
	"sync/atomic"

	"github.com/miekg/dns"
)

// Handler answers queries from the current zone snapshot. The same zone and challenge store
// serve both listeners; only the update listener (loopback) accepts UPDATE, and only the public
// listener is rate limited.
type Handler struct {
	cfg        *Config
	zone       *atomic.Pointer[Zone]
	challenges *Challenges
	limiter    *RateLimiter // nil on the update listener
	updates    bool         // true only on the loopback update listener
}

func remoteIP(w dns.ResponseWriter) net.IP {
	switch addr := w.RemoteAddr().(type) {
	case *net.UDPAddr:
		return addr.IP
	case *net.TCPAddr:
		return addr.IP
	}
	return nil
}

func isUDP(w dns.ResponseWriter) bool {
	_, ok := w.RemoteAddr().(*net.UDPAddr)
	return ok
}

func (h *Handler) ServeDNS(w dns.ResponseWriter, r *dns.Msg) {
	if r.Opcode == dns.OpcodeUpdate && h.updates {
		h.handleUpdate(w, r)
		return
	}
	// Rate limit before doing any work. UDP only: TCP needs a handshake, so it cannot be spoofed
	// for reflection, and it is bounded by the connection limits instead.
	if h.limiter != nil && isUDP(w) {
		switch h.limiter.Allow(remoteIP(w)) {
		case rateDrop:
			return
		case rateSlip:
			reply := new(dns.Msg)
			reply.SetReply(r)
			reply.Truncated = true
			reply.Authoritative = true
			_ = w.WriteMsg(reply)
			return
		}
	}
	_ = w.WriteMsg(h.answer(r, isUDP(w)))
}

// answer builds the reply to one query.
func (h *Handler) answer(r *dns.Msg, udp bool) *dns.Msg {
	reply := new(dns.Msg)
	reply.SetReply(r)
	reply.RecursionAvailable = false
	reply.Compress = true
	maxSize := dns.MinMsgSize
	if opt := r.IsEdns0(); opt != nil {
		if opt.Version() != 0 {
			reply.SetRcode(r, dns.RcodeBadVers)
			reply.SetEdns0(uint16(h.cfg.MaxUDPSize), false)
			return reply
		}
		if size := int(opt.UDPSize()); size > maxSize {
			maxSize = size
		}
		if maxSize > h.cfg.MaxUDPSize {
			maxSize = h.cfg.MaxUDPSize
		}
		reply.SetEdns0(uint16(h.cfg.MaxUDPSize), false)
	}
	switch {
	case r.Opcode != dns.OpcodeQuery:
		// NOTIFY, and UPDATE on the public listener: this server has no secondaries and takes
		// updates only on loopback.
		reply.Rcode = dns.RcodeRefused
	case len(r.Question) != 1:
		reply.Rcode = dns.RcodeFormatError
	case r.Question[0].Qclass != dns.ClassINET:
		reply.Rcode = dns.RcodeRefused // no CHAOS (version.bind) or other classes
	case r.Question[0].Qtype == dns.TypeAXFR || r.Question[0].Qtype == dns.TypeIXFR:
		reply.Rcode = dns.RcodeRefused // never transfer the zone (enumeration)
	default:
		zone := h.zone.Load()
		result := zone.Lookup(r.Question[0].Name, r.Question[0].Qtype, h.challenges)
		reply.Rcode = result.Rcode
		reply.Authoritative = result.Rcode != dns.RcodeRefused
		reply.Answer = result.Answer
		reply.Ns = result.Authority
	}
	if udp {
		reply.Truncate(maxSize) // sets TC when the answer does not fit: the client retries over TCP
	}
	return reply
}
