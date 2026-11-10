// Spike backend standing in for the vm-agent: HTTP + WebSocket echo on loopback.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
)

var node = flag.String("node", "node-a", "node name reported in responses")
var listen = flag.String("listen", "127.0.0.1:8444", "listen address (loopback, like PR #2615's tunnel ingress)")

var upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func writeJSON(w http.ResponseWriter, v any) { w.Header().Set("Content-Type", "application/json"); json.NewEncoder(w).Encode(v) }

func main() {
	flag.Parse()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "node": *node, "host": r.Host, "xff": r.Header.Get("X-Forwarded-For"), "spikeNode": r.Header.Get("X-Spike-Node")})
	})
	// GET /bytes?n=N streams N bytes.
	mux.HandleFunc("/bytes", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.ParseInt(r.URL.Query().Get("n"), 10, 64)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.FormatInt(n, 10))
		buf := make([]byte, 256*1024)
		for i := range buf { buf[i] = byte(i) }
		for n > 0 {
			c := int64(len(buf)); if n < c { c = n }
			if _, err := w.Write(buf[:c]); err != nil { log.Printf("bytes write: %v", err); return }
			n -= c
		}
	})
	// POST /sink consumes the body and reports size + hash.
	mux.HandleFunc("/sink", func(w http.ResponseWriter, r *http.Request) {
		start := time.Now(); h := sha256.New()
		n, err := io.Copy(h, r.Body)
		res := map[string]any{"node": *node, "bytes": n, "ms": time.Since(start).Milliseconds(), "sha256": hex.EncodeToString(h.Sum(nil))}
		if err != nil { res["error"] = err.Error() }
		writeJSON(w, res)
	})
	// GET /drip?count=N&interval=ms streams N lines spaced by interval (streaming + idle behaviour).
	mux.HandleFunc("/drip", func(w http.ResponseWriter, r *http.Request) {
		count, _ := strconv.Atoi(r.URL.Query().Get("count")); iv, _ := strconv.Atoi(r.URL.Query().Get("interval"))
		f, _ := w.(http.Flusher)
		for i := 0; i < count; i++ {
			if _, err := fmt.Fprintf(w, "tick %d %d\n", i, time.Now().UnixMilli()); err != nil { log.Printf("drip: client gone at %d: %v", i, err); return }
			f.Flush(); time.Sleep(time.Duration(iv) * time.Millisecond)
		}
	})
	// GET /ws: echo text+binary; "close:CODE:reason" closes with that code; "tick:MS" makes the server push every MS.
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil { log.Printf("upgrade: %v", err); return }
		defer c.Close()
		opened := time.Now()
		c.WriteMessage(websocket.TextMessage, []byte("hello from "+*node))
		for {
			mt, msg, err := c.ReadMessage()
			if err != nil { log.Printf("ws read end after %s: %v", time.Since(opened), err); return }
			s := string(msg)
			if mt == websocket.TextMessage && len(s) > 6 && s[:6] == "close:" {
				var code int; var reason string
				fmt.Sscanf(s[6:], "%d:%s", &code, &reason)
				c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason))
				time.Sleep(200 * time.Millisecond); return
			}
			if mt == websocket.TextMessage && len(s) > 6 && s[:6] == "flood:" {
				// Push N MiB in 64 KiB binary frames as fast as the connection accepts, then "flood-done".
				mib, _ := strconv.Atoi(s[6:]); chunk := make([]byte, 64*1024); start := time.Now()
				for i := 0; i < mib*16; i++ {
					if err := c.WriteMessage(websocket.BinaryMessage, chunk); err != nil { log.Printf("flood write failed at frame %d: %v", i, err); return }
				}
				log.Printf("flood %d MiB written in %s", mib, time.Since(start))
				c.WriteMessage(websocket.TextMessage, []byte("flood-done"))
				continue
			}
			if mt == websocket.TextMessage && len(s) > 5 && s[:5] == "tick:" {
				ms, _ := strconv.Atoi(s[5:])
				go func() {
					for i := 0; ; i++ {
						time.Sleep(time.Duration(ms) * time.Millisecond)
						if err := c.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("tick %d", i))); err != nil { return }
					}
				}()
				continue
			}
			if err := c.WriteMessage(mt, msg); err != nil { return }
		}
	})
	log.Printf("backend %s listening on %s", *node, *listen)
	log.Fatal((&http.Server{Addr: *listen, Handler: mux}).ListenAndServe())
}
