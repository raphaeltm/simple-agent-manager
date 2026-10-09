package cli

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
)

type pagingContract struct {
	items, continuation, parameter string
	offset                         bool
}

func pagingFor(command string) (pagingContract, bool) {
	switch command {
	case "notifications list":
		return pagingContract{items: "notifications", continuation: "nextCursor", parameter: "cursor"}, true
	case "tasks list", "ideas list":
		return pagingContract{items: "tasks", continuation: "nextCursor", parameter: "cursor"}, true
	case "library list":
		return pagingContract{items: "files", continuation: "cursor", parameter: "cursor"}, true
	case "chat list":
		return pagingContract{items: "sessions", continuation: "total", parameter: "offset", offset: true}, true
	case "context list":
		return pagingContract{items: "entities", continuation: "total", parameter: "offset", offset: true}, true
	default:
		return pagingContract{}, false
	}
}
func drainPages(ctx context.Context, client APIClient, path string, q url.Values, paging pagingContract) (map[string]any, error) {
	var combined []any
	seen := map[string]bool{}
	offset, _ := strconv.Atoi(q.Get("offset"))
	for {
		var page map[string]any
		if err := client.request(ctx, http.MethodGet, path+"?"+q.Encode(), nil, &page); err != nil {
			return nil, err
		}
		rows, ok := page[paging.items].([]any)
		if !ok {
			return nil, fmt.Errorf("invalid %s page", paging.items)
		}
		combined = append(combined, rows...)
		next, _ := page[paging.continuation].(string)
		var err error
		if paging.offset {
			offset, next, err = offsetContinuation(page, paging.continuation, offset, len(rows))
			if err != nil {
				return nil, err
			}
		}
		if next == "" {
			page[paging.items] = combined
			page["complete"] = true
			return page, nil
		}
		if len(rows) == 0 || seen[next] {
			return nil, fmt.Errorf("pagination made no progress; result incomplete")
		}
		seen[next] = true
		q.Set(paging.parameter, next)
	}
}

func offsetContinuation(page map[string]any, field string, offset, count int) (int, string, error) {
	total, ok := page[field].(float64)
	if !ok {
		return offset, "", fmt.Errorf("missing pagination total; use explicit page controls")
	}
	offset += count
	if offset < int(total) {
		return offset, strconv.Itoa(offset), nil
	}
	return offset, "", nil
}
