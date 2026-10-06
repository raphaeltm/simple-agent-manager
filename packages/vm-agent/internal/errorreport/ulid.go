package errorreport

import (
	"crypto/rand"
	"encoding/binary"
	"sync"
	"time"
)

const crockfordBase32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

type monotonicULID struct {
	mu          sync.Mutex
	lastMillis  uint64
	lastEntropy [10]byte
}

func (g *monotonicULID) next(now time.Time) string {
	g.mu.Lock()
	defer g.mu.Unlock()

	millis := uint64(now.UTC().UnixMilli())
	if millis > g.lastMillis {
		g.lastMillis = millis
		if _, err := rand.Read(g.lastEntropy[:]); err != nil {
			binary.BigEndian.PutUint64(g.lastEntropy[2:], uint64(now.UnixNano()))
		}
	} else {
		millis = g.lastMillis
		incrementEntropy(&g.lastEntropy)
	}

	var raw [16]byte
	raw[0] = byte(millis >> 40)
	raw[1] = byte(millis >> 32)
	raw[2] = byte(millis >> 24)
	raw[3] = byte(millis >> 16)
	raw[4] = byte(millis >> 8)
	raw[5] = byte(millis)
	copy(raw[6:], g.lastEntropy[:])
	return encodeULID(raw)
}

func incrementEntropy(entropy *[10]byte) {
	for i := len(entropy) - 1; i >= 0; i-- {
		entropy[i]++
		if entropy[i] != 0 {
			return
		}
	}
}

func encodeULID(raw [16]byte) string {
	var out [26]byte
	out[0] = crockfordBase32[(raw[0]&224)>>5]
	out[1] = crockfordBase32[raw[0]&31]
	out[2] = crockfordBase32[(raw[1]&248)>>3]
	out[3] = crockfordBase32[((raw[1]&7)<<2)|((raw[2]&192)>>6)]
	out[4] = crockfordBase32[(raw[2]&62)>>1]
	out[5] = crockfordBase32[((raw[2]&1)<<4)|((raw[3]&240)>>4)]
	out[6] = crockfordBase32[((raw[3]&15)<<1)|((raw[4]&128)>>7)]
	out[7] = crockfordBase32[(raw[4]&124)>>2]
	out[8] = crockfordBase32[((raw[4]&3)<<3)|((raw[5]&224)>>5)]
	out[9] = crockfordBase32[raw[5]&31]
	bit := 0
	for i := 10; i < 26; i++ {
		byteIndex := 6 + bit/8
		shift := 11 - (bit % 8)
		var value uint16 = uint16(raw[byteIndex]) << 8
		if byteIndex+1 < len(raw) {
			value |= uint16(raw[byteIndex+1])
		}
		out[i] = crockfordBase32[(value>>shift)&31]
		bit += 5
	}
	return string(out[:])
}
