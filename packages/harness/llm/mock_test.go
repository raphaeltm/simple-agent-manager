package llm

import (
	"context"
	"testing"
)

func TestMockProvider_ReturnsScriptedResponses(t *testing.T) {
	resp1 := &Response{Content: "hello"}
	resp2 := &Response{Content: "world"}

	mock := NewMockProvider(resp1, resp2)

	got1, err := mock.SendMessage(context.Background(), nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got1.Content != "hello" {
		t.Errorf("got %q, want %q", got1.Content, "hello")
	}

	got2, err := mock.SendMessage(context.Background(), nil, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got2.Content != "world" {
		t.Errorf("got %q, want %q", got2.Content, "world")
	}
}

func TestMockProvider_ExhaustedResponses(t *testing.T) {
	mock := NewMockProvider(&Response{Content: "only one"})

	_, _ = mock.SendMessage(context.Background(), nil, nil)
	_, err := mock.SendMessage(context.Background(), nil, nil)
	if err == nil {
		t.Fatal("expected error when responses exhausted")
	}
}

func TestMockProvider_RecordsCalls(t *testing.T) {
	mock := NewMockProvider(&Response{Content: "ok"})

	msgs := []Message{{Role: RoleUser, Content: "test"}}
	_, _ = mock.SendMessage(context.Background(), msgs, nil)

	if mock.CallCount() != 1 {
		t.Errorf("call count = %d, want 1", mock.CallCount())
	}
	recorded := mock.CallMessages(0)
	if len(recorded) != 1 || recorded[0].Content != "test" {
		t.Error("recorded messages don't match sent messages")
	}
}
