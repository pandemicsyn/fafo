package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func newTestFlags() *flag.FlagSet { return flag.NewFlagSet("test", flag.ContinueOnError) }
func fixturePath() string         { return filepath.Join("fixtures", "triage.json") }
func mockAnswer(q Question) map[string]any {
	switch q.Type {
	case "noul":
		return map[string]any{"type": "noul", "noul": 0.8}
	case "choice":
		return map[string]any{"type": "choice", "choice": "supported", "probabilities": map[string]float64{"supported": 0.8, "contradicted": 0.1, "unsupported": 0.1}, "confidence": 0.7}
	default:
		return map[string]any{"type": "score", "score": 2.2, "legend": map[string]string{"0": "No actionable defect: expected behavior or claim contradicted by the report.", "1": "Possible concern, but source evidence or expected behavior is missing.", "2": "Concrete issue with credible evidence, but reproduction or key detail is incomplete.", "3": "Clear actionable issue with reproducible evidence or an urgent verified exposure."}, "probabilities": map[string]float64{"0": 0.1, "1": 0.1, "2": 0.3, "3": 0.5}, "confidence": 0.6}
	}
}
func TestValidation(t *testing.T) {
	f, _, e := loadFixture(fixturePath())
	if e != nil {
		t.Fatal(e)
	}
	for _, p := range primitives {
		q := questions(f, p, 4)
		a := map[string]json.RawMessage{}
		for id, v := range q {
			b, _ := json.Marshal(mockAnswer(v))
			a[id] = b
		}
		if got := validateAnswers(q, a); got != "" {
			t.Fatalf("%s valid: %s", p, got)
		}
		delete(a, "case_A")
		if got := validateAnswers(q, a); got == "" {
			t.Fatalf("%s missing ID accepted", p)
		}
	}
	q := questions(f, "choice", 1)
	a := map[string]json.RawMessage{"case_A": json.RawMessage(`{"type":"choice","choice":"invented","probabilities":{"supported":1}}`)}
	if validateAnswers(q, a) == "" {
		t.Fatal("undeclared choice accepted")
	}
}

func TestMixedBatch(t *testing.T) {
	f, _, e := loadFixture(fixturePath())
	if e != nil {
		t.Fatal(e)
	}
	q := questions(f, "mixed", 16)
	counts := map[string]int{}
	for _, question := range q {
		counts[question.Type]++
	}
	if counts["noul"] != 6 || counts["choice"] != 5 || counts["score"] != 5 {
		t.Fatalf("mixed counts: %v", counts)
	}
	answers := map[string]json.RawMessage{}
	for id, question := range q {
		b, _ := json.Marshal(mockAnswer(question))
		answers[id] = b
	}
	if got := validateAnswers(q, answers); got != "" {
		t.Fatal(got)
	}
	fs := newTestFlags()
	c, _, s, e := setup(fs, []string{"-fixture", fixturePath(), "-primitives", "mixed", "-batches", "16", "-reps", "2"})
	if e != nil || len(s) != 6 || !reflect.DeepEqual(c.Primitives, []string{"mixed"}) {
		t.Fatalf("mixed schedule=%d config=%+v error=%v", len(s), c, e)
	}
	one, e := requestBody(f, "mixed", 16, "jev-latest", "blog-run", 0)
	if e != nil {
		t.Fatal(e)
	}
	two, e := requestBody(f, "mixed", 16, "jev-latest", "blog-run", 1)
	if e != nil || bytes.Equal(one, two) {
		t.Fatal("repetitions must use distinct request bodies", e)
	}
	var payload struct {
		State map[string]json.RawMessage `json:"state"`
	}
	if e = json.Unmarshal(one, &payload); e != nil || !bytes.Equal(payload.State["benchmark_sample_id"], []byte(`"blog-run-000000"`)) {
		t.Fatalf("sample ID missing: %s (%v)", payload.State["benchmark_sample_id"], e)
	}
	fs = newTestFlags()
	_, _, full, e := setup(fs, []string{"-fixture", fixturePath(), "-primitives", "noul,choice,score,mixed", "-batches", "1,4,16", "-reps", "100"})
	if e != nil || len(full) != 3000 {
		t.Fatalf("full mixed schedule=%d error=%v", len(full), e)
	}
}

func TestScheduleBalancedAndNested(t *testing.T) {
	c := Config{Batches: []int{1, 4, 16}, Reps: 100, Seed: 42}
	s := schedule(c)
	if len(s) != 2700 {
		t.Fatalf("requests=%d", len(s))
	}
	positions := map[string][3]int{}
	for i := 0; i < len(s); i += 3 {
		for j := 0; j < 3; j++ {
			trial := s[i+j]
			k := trial.Primitive + "/" + strconv.Itoa(trial.Batch) + "/" + trial.Provider
			counts := positions[k]
			counts[j]++
			positions[k] = counts
			if trial.Block != s[i].Block {
				t.Fatal("matched calls are not adjacent")
			}
		}
	}
	for k, counts := range positions {
		for _, n := range counts {
			if n < 33 || n > 34 {
				t.Fatalf("unbalanced %s: %v", k, counts)
			}
		}
	}
	sections := 0
	for i := 1; i < len(s); i++ {
		if s[i].Session == s[i-1].Session && (s[i].Batch != s[i-1].Batch || s[i].Primitive != s[i-1].Primitive) {
			sections++
		}
	}
	if sections != 16 {
		t.Fatalf("expected 16 section boundaries, got %d", sections)
	}
	f, _, err := loadFixture(fixturePath())
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range primitives {
		q1, q4, q16 := questions(f, p, 1), questions(f, p, 4), questions(f, p, 16)
		for id, v := range q1 {
			if !reflect.DeepEqual(q4[id], v) || !reflect.DeepEqual(q16[id], v) {
				t.Fatal("subsets changed question", id)
			}
		}
		for id, v := range q4 {
			if !reflect.DeepEqual(q16[id], v) {
				t.Fatal("subsets changed question", id)
			}
		}
	}
}
func TestMockSessionsResumeAndReport(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Method != "POST" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			t.Errorf("request headers: %v", r.Header)
			w.WriteHeader(400)
			return
		}
		var req struct {
			Model     string              `json:"model"`
			Questions map[string]Question `json:"questions"`
		}
		if e := json.NewDecoder(r.Body).Decode(&req); e != nil {
			t.Error(e)
			w.WriteHeader(400)
			return
		}
		answers := map[string]any{}
		for id, q := range req.Questions {
			answers[id] = mockAnswer(q)
		}
		w.Header().Set("X-Request-ID", "mock-id")
		json.NewEncoder(w).Encode(map[string]any{"model": "mock-resolved", "answers": answers, "usage": map[string]any{"input_tokens": 100, "output_tokens": 4}})
	}))
	defer srv.Close()
	for _, p := range providers {
		t.Setenv("JEV_BENCH_"+strings.ToUpper(p)+"_URL", srv.URL)
		switch p {
		case "typesafe":
			t.Setenv("TYPESAFE_API_KEY", "test")
		case "vercel":
			t.Setenv("AI_GATEWAY_API_KEY", "test")
		case "openrouter":
			t.Setenv("OPENROUTER_API_KEY", "test")
		}
	}
	fs := newTestFlags()
	c, f, s, e := setup(fs, []string{"-fixture", fixturePath(), "-reps", "2", "-batches", "1", "-transition-pause", "0"})
	if e != nil {
		t.Fatal(e)
	}
	out := filepath.Join(t.TempDir(), "results")
	if e = run(out, 1, c, f, s); e != nil {
		t.Fatal(e)
	}
	if hits != 9 {
		t.Fatalf("session 1 hits=%d", hits)
	}
	if e = run(out, 1, c, f, s); e != nil {
		t.Fatal(e)
	}
	if hits != 9 {
		t.Fatal("resume duplicated calls")
	}
	if e = run(out, 2, c, f, s); e != nil {
		t.Fatal(e)
	}
	if hits != 18 {
		t.Fatalf("both sessions hits=%d", hits)
	}
	r, e := loadRecords(out)
	if e != nil || len(r) != 18 {
		t.Fatalf("records=%d error=%v", len(r), e)
	}
	for _, v := range r {
		if v.Error != "" || v.ReturnedModel != "mock-resolved" || v.RequestID != "mock-id" {
			t.Fatalf("bad record %+v", v)
		}
	}
	if e = report(out, c, s); e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"summary.csv", "pairs.csv", "dnf.csv", "report.md"} {
		b, e := os.ReadFile(filepath.Join(out, name))
		if e != nil || len(b) == 0 {
			t.Fatalf("missing %s: %v", name, e)
		}
	}
}
func TestFailureRetained(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "4")
		w.Header().Set("X-RateLimit-Limit", "30")
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"error":"rate limited"}`))
	}))
	defer srv.Close()
	for _, p := range providers {
		t.Setenv("JEV_BENCH_"+strings.ToUpper(p)+"_URL", srv.URL)
	}
	t.Setenv("TYPESAFE_API_KEY", "test")
	t.Setenv("AI_GATEWAY_API_KEY", "test")
	t.Setenv("OPENROUTER_API_KEY", "test")
	fs := newTestFlags()
	c, f, s, e := setup(fs, []string{"-fixture", fixturePath(), "-reps", "2", "-batches", "1", "-transition-pause", "0"})
	if e != nil {
		t.Fatal(e)
	}
	out := t.TempDir()
	_ = run(out, 1, c, f, s)
	r, e := loadRecords(out)
	if e != nil || len(r) == 0 {
		t.Fatalf("failure not recorded: %v", e)
	}
	for _, v := range r {
		if v.Error == "" || v.Status != 429 || v.RetryAfter != "4" || !strings.Contains(v.ErrorBody, "rate limited") || v.RateLimit["X-Ratelimit-Limit"] != "30" {
			t.Fatalf("bad failure %+v", v)
		}
	}
}
