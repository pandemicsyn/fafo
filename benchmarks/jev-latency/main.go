package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net"
	"net/http"
	"net/http/httptrace"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Item struct{ ID, Signal, Candidate string }
type Fixture struct {
	Name  string          `json:"name"`
	State json.RawMessage `json:"state"`
	Items []Item          `json:"items"`
}
type Question struct {
	Type         string `json:"type"`
	Instructions string `json:"instructions"`
	Criteria     any    `json:"criteria"`
}
type Config struct {
	Fixture           string            `json:"fixture"`
	FixtureHash       string            `json:"fixture_hash"`
	Batches           []int             `json:"batches"`
	Primitives        []string          `json:"primitives,omitempty"`
	SampleTag         string            `json:"sample_tag,omitempty"`
	Reps              int               `json:"reps"`
	Seed              int64             `json:"seed"`
	TransitionPauseMS int               `json:"transition_pause_ms"`
	TimeoutSec        int               `json:"timeout_sec"`
	Models            map[string]string `json:"models"`
	URLs              map[string]string `json:"urls"`
}
type Manifest struct {
	Config       Config `json:"config"`
	ScheduleHash string `json:"schedule_hash"`
	Created      string `json:"created"`
	Hostname     string `json:"hostname"`
	GoVersion    string `json:"go_version"`
	Location     string `json:"location"`
}
type Trial struct {
	Key, Block, Provider, Primitive string
	Batch, Rep, Session             int
}
type Record struct {
	Key              string            `json:"key"`
	Block            string            `json:"block"`
	Provider         string            `json:"provider"`
	Primitive        string            `json:"primitive"`
	Batch            int               `json:"batch"`
	Rep              int               `json:"rep"`
	Session          int               `json:"session"`
	At               string            `json:"at"`
	RequestedModel   string            `json:"requested_model"`
	ReturnedModel    string            `json:"returned_model,omitempty"`
	Protocol         string            `json:"protocol,omitempty"`
	Status           int               `json:"status"`
	RequestBytes     int               `json:"request_bytes"`
	ResponseBytes    int               `json:"response_bytes"`
	TotalMS          float64           `json:"total_ms"`
	FirstByteMS      float64           `json:"first_byte_ms,omitempty"`
	BodyDoneMS       float64           `json:"body_done_ms,omitempty"`
	ValidationMS     float64           `json:"validation_ms,omitempty"`
	GetConnMS        float64           `json:"get_conn_ms,omitempty"`
	GotConnMS        float64           `json:"got_conn_ms,omitempty"`
	ConnWaitMS       float64           `json:"conn_wait_ms,omitempty"`
	DNSMS            float64           `json:"dns_ms,omitempty"`
	TCPMS            float64           `json:"tcp_ms,omitempty"`
	TLSMS            float64           `json:"tls_ms,omitempty"`
	Reused           *bool             `json:"reused,omitempty"`
	RequestID        string            `json:"request_id,omitempty"`
	Cache            map[string]string `json:"cache,omitempty"`
	Usage            json.RawMessage   `json:"usage,omitempty"`
	ProviderMetadata json.RawMessage   `json:"provider_metadata,omitempty"`
	Answers          json.RawMessage   `json:"answers,omitempty"`
	Error            string            `json:"error,omitempty"`
	ErrorBody        string            `json:"error_body,omitempty"`
	RetryAfter       string            `json:"retry_after,omitempty"`
	RateLimit        map[string]string `json:"rate_limit,omitempty"`
	Timeout          bool              `json:"timeout,omitempty"`
}

var providers = []string{"typesafe", "vercel", "openrouter"}
var primitives = []string{"noul", "choice", "score"}

func selectedPrimitives(c Config) []string {
	if len(c.Primitives) != 0 {
		return c.Primitives
	}
	return primitives
}

func includeCell(primitive string, batch int) bool {
	return primitive != "mixed" || batch == 16
}

func parsePrimitives(s string) ([]string, error) {
	if s == "" {
		return nil, nil
	}
	var out []string
	seen := map[string]bool{}
	for _, part := range strings.Split(s, ",") {
		p := strings.TrimSpace(part)
		if (p != "noul" && p != "choice" && p != "score" && p != "mixed") || seen[p] {
			return nil, fmt.Errorf("invalid or duplicate primitive %q", p)
		}
		seen[p] = true
		out = append(out, p)
	}
	return out, nil
}

func hash(b []byte) string { x := sha256.Sum256(b); return hex.EncodeToString(x[:]) }
func fatal(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func parseBatches(s string) ([]int, error) {
	var out []int
	seen := map[int]bool{}
	for _, p := range strings.Split(s, ",") {
		n, e := strconv.Atoi(strings.TrimSpace(p))
		if e != nil || n < 1 || n > 16 || seen[n] {
			return nil, fmt.Errorf("invalid batch %q: use distinct sizes from 1 to 16", p)
		}
		seen[n] = true
		out = append(out, n)
	}
	sort.Ints(out)
	return out, nil
}
func loadFixture(path string) (Fixture, string, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return Fixture{}, "", e
	}
	var f Fixture
	if e = json.Unmarshal(b, &f); e != nil {
		return f, "", e
	}
	if len(f.Items) < 16 || len(f.State) == 0 {
		return f, "", errors.New("fixture requires state and at least 16 distinct items")
	}
	seen := map[string]bool{}
	for _, i := range f.Items {
		if i.ID == "" || seen[i.ID] || i.Signal == "" || i.Candidate == "" {
			return f, "", errors.New("fixture item IDs must be unique and fields nonempty")
		}
		seen[i.ID] = true
	}
	return f, hash(b), nil
}
func questions(f Fixture, p string, n int) map[string]Question {
	q := map[string]Question{}
	for i, it := range f.Items[:n] {
		id := "case_" + it.ID
		base := "For case " + it.ID + " in `state.report` and `state.proposed_issues`, assess the proposed issue `" + it.Candidate + "` using the report and policy. "
		kind := p
		if p == "mixed" {
			kind = primitives[i%len(primitives)]
		}
		switch kind {
		case "noul":
			q[id] = Question{"noul", base + "Does the source evidence directly support the proposed issue's central factual claim?", map[string]string{"true": "The report explicitly supports the central claim.", "false": "The claim is contradicted or lacks the required evidence."}}
		case "choice":
			q[id] = Question{"choice", base + "What is the evidence status of the proposed issue's central claim?", map[string]string{"supported": "The report directly supports the claim.", "contradicted": "The report explicitly states a conflicting fact.", "unsupported": "The report lacks enough evidence to establish or refute the claim."}}
		case "score":
			q[id] = Question{"score", base + "How actionable is this proposed issue as written, based only on the supplied evidence?", []string{"No actionable defect: expected behavior or claim contradicted by the report.", "Possible concern, but source evidence or expected behavior is missing.", "Concrete issue with credible evidence, but reproduction or key detail is incomplete.", "Clear actionable issue with reproducible evidence or an urgent verified exposure."}}
		}
	}
	return q
}
func requestBody(f Fixture, p string, n int, model, sampleTag string, rep int) ([]byte, error) {
	state := f.State
	if sampleTag != "" {
		var fields map[string]json.RawMessage
		if e := json.Unmarshal(f.State, &fields); e != nil {
			return nil, e
		}
		id, _ := json.Marshal(fmt.Sprintf("%s-%06d", sampleTag, rep))
		fields["benchmark_sample_id"] = id
		var e error
		state, e = json.Marshal(fields)
		if e != nil {
			return nil, e
		}
	}
	return json.Marshal(struct {
		Model     string              `json:"model"`
		State     json.RawMessage     `json:"state"`
		Questions map[string]Question `json:"questions"`
	}{model, state, questions(f, p, n)})
}
func schedule(c Config) []Trial {
	var s []Trial
	split := (c.Reps + 1) / 2
	for session := 1; session <= 2; session++ {
		start, end := 0, split
		if session == 2 {
			start, end = split, c.Reps
		}
		for _, batch := range c.Batches {
			for primitiveIndex, primitive := range selectedPrimitives(c) {
				if !includeCell(primitive, batch) {
					continue
				}
				for rep := start; rep < end; rep++ {
					base := append([]string{}, providers...)
					rng := rand.New(rand.NewSource(c.Seed + int64(batch)*100000000 + int64(primitiveIndex)*1000000 + int64(rep/3)))
					rng.Shuffle(len(base), func(i, j int) { base[i], base[j] = base[j], base[i] })
					order := []string{base[rep%3], base[(rep+1)%3], base[(rep+2)%3]}
					block := fmt.Sprintf("%s/%d/%03d", primitive, batch, rep)
					for _, provider := range order {
						s = append(s, Trial{Key: block + "/" + provider, Block: block, Provider: provider, Primitive: primitive, Batch: batch, Rep: rep, Session: session})
					}
				}
			}
		}
	}
	return s
}
func pauseAtTransition(previous, current Trial) bool {
	return previous.Provider == "openrouter" && current.Provider == "vercel" || previous.Batch != current.Batch || previous.Primitive != current.Primitive
}
func setup(fs *flag.FlagSet, args []string) (Config, Fixture, []Trial, error) {
	c := Config{}
	var batch, primitiveList string
	fs.StringVar(&c.Fixture, "fixture", "fixtures/triage.json", "JSON fixture")
	fs.StringVar(&batch, "batches", "1,4,16", "batch sizes")
	fs.StringVar(&primitiveList, "primitives", "", "comma-separated noul,choice,score,mixed; default noul,choice,score")
	fs.StringVar(&c.SampleTag, "sample-tag", "", "fixed run tag used to vary state metadata by repetition")
	fs.IntVar(&c.Reps, "reps", 100, "repetitions per configuration")
	fs.Int64Var(&c.Seed, "seed", 20260922, "schedule seed")
	fs.IntVar(&c.TransitionPauseMS, "transition-pause", 250, "milliseconds only at OpenRouter-to-Vercel, primitive, or batch transitions")
	fs.IntVar(&c.TimeoutSec, "timeout", 60, "request timeout in seconds")
	ts := fs.String("typesafe-model", "jev-latest", "model")
	ve := fs.String("gateway-model", "typesafe-ai/jev", "model")
	or := fs.String("openrouter-model", "typesafe/jev-1.13", "model")
	if e := fs.Parse(args); e != nil {
		return c, Fixture{}, nil, e
	}
	var e error
	c.Batches, e = parseBatches(batch)
	if e != nil {
		return c, Fixture{}, nil, e
	}
	c.Primitives, e = parsePrimitives(primitiveList)
	if e != nil {
		return c, Fixture{}, nil, e
	}
	if c.Reps < 2 || c.TransitionPauseMS < 0 || c.TimeoutSec < 1 {
		return c, Fixture{}, nil, errors.New("reps >=2, transition-pause >=0, timeout >=1 required")
	}
	if len(c.SampleTag) > 48 || strings.ContainsAny(c.SampleTag, "\r\n\t") {
		return c, Fixture{}, nil, errors.New("sample-tag must be at most 48 characters without control whitespace")
	}
	f, h, e := loadFixture(c.Fixture)
	if e != nil {
		return c, f, nil, e
	}
	c.FixtureHash = h
	c.Models = map[string]string{"typesafe": *ts, "vercel": *ve, "openrouter": *or}
	c.URLs = map[string]string{"typesafe": "https://api.typesafe.ai/v1/systemone", "vercel": "https://ai-gateway.vercel.sh/typesafe/v1/systemone", "openrouter": "https://openrouter.ai/api/alpha/decisions"}
	for _, p := range providers {
		if v := os.Getenv("JEV_BENCH_" + strings.ToUpper(p) + "_URL"); v != "" {
			c.URLs[p] = v
		}
	}
	return c, f, schedule(c), nil
}
func scheduleHash(s []Trial) string { b, _ := json.Marshal(s); return hash(b) }
func dryRun(c Config, f Fixture, s []Trial) error {
	fmt.Printf("Fixture: %s sha256=%s; state=%d bytes (~%d tokens at 4 bytes/token)\n", f.Name, c.FixtureHash, len(f.State), len(f.State)/4)
	first := 0
	for _, t := range s {
		if t.Session == 1 {
			first++
		}
	}
	pauses := 0
	for i := 1; i < len(s); i++ {
		if s[i].Session == s[i-1].Session && pauseAtTransition(s[i-1], s[i]) {
			pauses++
		}
	}
	fmt.Printf("Schedule: sha256=%s, seed=%d, %d requests (%d per provider), sessions %d + %d\n", scheduleHash(s), c.Seed, len(s), len(s)/3, first, len(s)-first)
	fmt.Printf("Pacing: %d transition pauses of %d ms (%.1f seconds planned total); no per-request sleep\n", pauses, c.TransitionPauseMS, float64(pauses*c.TransitionPauseMS)/1000)
	for _, p := range providers {
		fmt.Printf("%s: %s model=%s\n", p, c.URLs[p], c.Models[p])
	}
	var directBytes int
	for _, t := range s {
		if t.Provider != "typesafe" {
			continue
		}
		b, e := requestBody(f, t.Primitive, t.Batch, c.Models[t.Provider], c.SampleTag, t.Rep)
		if e != nil {
			return e
		}
		directBytes += len(b)
		if t.Rep == 0 {
			fmt.Printf("%s batch=%d request=%d bytes; state shared=%d bytes; questions=%d\n", t.Primitive, t.Batch, len(b), len(f.State), t.Batch)
		}
	}
	fmt.Printf("Direct TypeSafe rough input: %d tokens (serialized UTF-8 bytes / 4), $%.4f at $0.042/M; output assumed free. Actual API usage governs billing.\n", directBytes/4, float64(directBytes)/4*0.042/1e6)
	return nil
}
func manifest(c Config, s []Trial) Manifest {
	host, _ := os.Hostname()
	loc := time.Now().Location().String()
	return Manifest{c, scheduleHash(s), time.Now().Format(time.RFC3339), host, runtime.Version(), loc}
}
func manifestFile(out string) string { return filepath.Join(out, "manifest.json") }
func scheduleFile(out string) string { return filepath.Join(out, "schedule.json") }
func recordsFile(out string) string  { return filepath.Join(out, "raw.jsonl") }
func readManifest(out string) (Manifest, error) {
	var m Manifest
	b, e := os.ReadFile(manifestFile(out))
	if e != nil {
		return m, e
	}
	e = json.Unmarshal(b, &m)
	return m, e
}
func loadRecords(out string) (map[string]Record, error) {
	all := map[string]Record{}
	b, e := os.ReadFile(recordsFile(out))
	if os.IsNotExist(e) {
		return all, nil
	}
	if e != nil {
		return nil, e
	}
	for lineNo, line := range bytes.Split(bytes.TrimSpace(b), []byte("\n")) {
		if len(line) == 0 {
			continue
		}
		var r Record
		if e = json.Unmarshal(line, &r); e != nil {
			return nil, fmt.Errorf("raw line %d: %w", lineNo+1, e)
		}
		if _, ok := all[r.Key]; ok {
			return nil, fmt.Errorf("duplicate raw key %s", r.Key)
		}
		all[r.Key] = r
	}
	return all, nil
}
func recordRequest(ctx context.Context, client *http.Client, c Config, f Fixture, t Trial, key string) Record {
	r := Record{Key: t.Key, Block: t.Block, Provider: t.Provider, Primitive: t.Primitive, Batch: t.Batch, Rep: t.Rep, Session: t.Session, At: time.Now().Format(time.RFC3339Nano), RequestedModel: c.Models[t.Provider]}
	start := time.Now()
	var dns, tcp, tlsStart time.Time
	tr := &httptrace.ClientTrace{GetConn: func(string) { r.GetConnMS = ms(start) }, GotConn: func(info httptrace.GotConnInfo) {
		r.GotConnMS = ms(start)
		r.ConnWaitMS = r.GotConnMS - r.GetConnMS
		v := info.Reused
		r.Reused = &v
	}, DNSStart: func(httptrace.DNSStartInfo) { dns = time.Now() }, DNSDone: func(httptrace.DNSDoneInfo) {
		if !dns.IsZero() {
			r.DNSMS = time.Since(dns).Seconds() * 1000
		}
	}, ConnectStart: func(_, _ string) { tcp = time.Now() }, ConnectDone: func(_, _ string, _ error) {
		if !tcp.IsZero() {
			r.TCPMS = time.Since(tcp).Seconds() * 1000
		}
	}, TLSHandshakeStart: func() { tlsStart = time.Now() }, TLSHandshakeDone: func(_ tls.ConnectionState, _ error) {
		if !tlsStart.IsZero() {
			r.TLSMS = time.Since(tlsStart).Seconds() * 1000
		}
	}, GotFirstResponseByte: func() { r.FirstByteMS = ms(start) }}
	// JSON encoding and request construction are intentionally within total latency.
	body, e := requestBody(f, t.Primitive, t.Batch, c.Models[t.Provider], c.SampleTag, t.Rep)
	r.RequestBytes = len(body)
	if e != nil {
		r.Error = e.Error()
		r.TotalMS = ms(start)
		return r
	}
	ctx = httptrace.WithClientTrace(ctx, tr)
	req, e := http.NewRequestWithContext(ctx, "POST", c.URLs[t.Provider], bytes.NewReader(body))
	if e != nil {
		r.Error = e.Error()
		r.TotalMS = ms(start)
		return r
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, e := client.Do(req)
	if e != nil {
		r.Error = e.Error()
		r.Timeout = isTimeout(e)
		r.TotalMS = ms(start)
		return r
	}
	defer resp.Body.Close()
	r.Status = resp.StatusCode
	r.Protocol = resp.Proto
	r.RequestID = firstHeader(resp.Header, "x-request-id", "x-vercel-id", "x-openrouter-request-id", "cf-ray")
	r.RetryAfter = resp.Header.Get("Retry-After")
	r.RateLimit = map[string]string{}
	for k, values := range resp.Header {
		if strings.Contains(strings.ToLower(k), "ratelimit") || strings.Contains(strings.ToLower(k), "rate-limit") {
			r.RateLimit[k] = strings.Join(values, ", ")
		}
	}
	r.Cache = map[string]string{}
	for _, k := range []string{"Age", "X-Cache", "CF-Cache-Status", "X-Vercel-Cache"} {
		if v := resp.Header.Get(k); v != "" {
			r.Cache[k] = v
		}
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	r.BodyDoneMS = ms(start)
	r.ResponseBytes = len(b)
	if e != nil {
		r.Error = e.Error()
		r.Timeout = isTimeout(e)
		r.TotalMS = ms(start)
		return r
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		r.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		r.ErrorBody = string(b[:min(len(b), 2048)])
		r.TotalMS = ms(start)
		return r
	}
	vstart := time.Now()
	var payload struct {
		Model            string                     `json:"model"`
		Answers          map[string]json.RawMessage `json:"answers"`
		Usage            json.RawMessage            `json:"usage"`
		Provider         json.RawMessage            `json:"provider"`
		ProviderMetadata json.RawMessage            `json:"provider_metadata"`
		ID               string                     `json:"id"`
	}
	if e = json.Unmarshal(b, &payload); e != nil {
		r.Error = "decode: " + e.Error()
	} else {
		r.ReturnedModel = payload.Model
		r.Usage = payload.Usage
		r.ProviderMetadata = payload.ProviderMetadata
		if len(r.ProviderMetadata) == 0 {
			r.ProviderMetadata = payload.Provider
		}
		if r.RequestID == "" {
			r.RequestID = payload.ID
		}
		r.Answers, _ = json.Marshal(payload.Answers)
		r.Error = validateAnswers(questions(f, t.Primitive, t.Batch), payload.Answers)
	}
	r.ValidationMS = time.Since(vstart).Seconds() * 1000
	r.TotalMS = ms(start)
	return r
}
func firstHeader(h http.Header, keys ...string) string {
	for _, k := range keys {
		if v := h.Get(k); v != "" {
			return v
		}
	}
	return ""
}
func ms(t time.Time) float64 { return time.Since(t).Seconds() * 1000 }
func isTimeout(e error) bool {
	var n net.Error
	return errors.As(e, &n) && n.Timeout() || errors.Is(e, context.DeadlineExceeded)
}
func prob(x float64) bool { return !math.IsNaN(x) && !math.IsInf(x, 0) && x >= 0 && x <= 1 }
func validateAnswers(q map[string]Question, a map[string]json.RawMessage) string {
	if len(a) != len(q) {
		return fmt.Sprintf("answer count %d, want %d", len(a), len(q))
	}
	for id, question := range q {
		raw, ok := a[id]
		if !ok {
			return "missing answer " + id
		}
		var v struct {
			Type          string             `json:"type"`
			Noul          *float64           `json:"noul"`
			Choice        string             `json:"choice"`
			Score         *float64           `json:"score"`
			Probabilities map[string]float64 `json:"probabilities"`
			Legend        map[string]string  `json:"legend"`
			Confidence    *float64           `json:"confidence"`
		}
		if e := json.Unmarshal(raw, &v); e != nil {
			return id + ": decode: " + e.Error()
		}
		if v.Type != question.Type {
			return id + ": wrong type"
		}
		if v.Confidence != nil && !prob(*v.Confidence) {
			return id + ": invalid confidence"
		}
		switch v.Type {
		case "noul":
			if v.Noul == nil || !prob(*v.Noul) {
				return id + ": invalid noul"
			}
		case "choice":
			criteria := question.Criteria.(map[string]string)
			if _, ok := criteria[v.Choice]; !ok {
				return id + ": undeclared choice"
			}
			if err := distribution(v.Probabilities, mapKeys(criteria)); err != "" {
				return id + ": " + err
			}
			for _, value := range v.Probabilities {
				if value > v.Probabilities[v.Choice]+0.011 {
					return id + ": choice is not highest probability"
				}
			}
		case "score":
			levels := []string{"0", "1", "2", "3"}
			if v.Score == nil || *v.Score < 0 || *v.Score > 3 {
				return id + ": invalid score"
			}
			if err := distribution(v.Probabilities, levels); err != "" {
				return id + ": " + err
			}
			if len(v.Legend) != 4 {
				return id + ": missing score legend"
			}
			for j, k := range levels {
				if v.Legend[k] != question.Criteria.([]string)[j] {
					return id + ": missing score level"
				}
			}
			weighted := 0.0
			for j, k := range levels {
				weighted += float64(j) * v.Probabilities[k]
			}
			if math.Abs(weighted-*v.Score) > 0.07 {
				return id + ": score disagrees with distribution"
			}
		}
	}
	return ""
}
func mapKeys(m map[string]string) []string {
	a := make([]string, 0, len(m))
	for k := range m {
		a = append(a, k)
	}
	return a
}
func distribution(p map[string]float64, keys []string) string {
	if len(p) != len(keys) {
		return "incomplete probability distribution"
	}
	sum := 0.0
	for _, k := range keys {
		v, ok := p[k]
		if !ok || !prob(v) {
			return "invalid probability for " + k
		}
		sum += v
	}
	if math.Abs(sum-1) > 0.03 {
		return "probabilities do not sum to 1"
	}
	return ""
}
func run(out string, session int, c Config, f Fixture, s []Trial) error {
	if session != 1 && session != 2 {
		return errors.New("-session must be 1 or 2")
	}
	keys := map[string]string{"typesafe": os.Getenv("TYPESAFE_API_KEY"), "vercel": os.Getenv("AI_GATEWAY_API_KEY"), "openrouter": os.Getenv("OPENROUTER_API_KEY")}
	for _, p := range providers {
		if keys[p] == "" {
			return fmt.Errorf("missing %s credential", p)
		}
	}
	if e := os.MkdirAll(out, 0700); e != nil {
		return e
	}
	lock, e := os.OpenFile(filepath.Join(out, "run.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer lock.Close()
	if e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		return errors.New("another benchmark session is active in this output directory")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	m, e := readManifest(out)
	if os.IsNotExist(e) {
		m = manifest(c, s)
		b, _ := json.MarshalIndent(m, "", "  ")
		if e = os.WriteFile(manifestFile(out), b, 0600); e != nil {
			return e
		}
		b, _ = json.MarshalIndent(s, "", "  ")
		if e = os.WriteFile(scheduleFile(out), b, 0600); e != nil {
			return e
		}
	} else if e != nil {
		return e
	} else {
		a, _ := json.Marshal(m.Config)
		b, _ := json.Marshal(c)
		if !bytes.Equal(a, b) || m.ScheduleHash != scheduleHash(s) {
			return errors.New("manifest configuration/schedule differs; choose a new output directory")
		}
	}
	stored, e := os.ReadFile(scheduleFile(out))
	if e != nil {
		return fmt.Errorf("missing saved schedule: %w", e)
	}
	var previous []Trial
	if e = json.Unmarshal(stored, &previous); e != nil || scheduleHash(previous) != m.ScheduleHash {
		return errors.New("saved schedule does not match manifest")
	}
	done, e := loadRecords(out)
	if e != nil {
		return e
	}
	file, e := os.OpenFile(recordsFile(out), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer file.Close()
	clients := map[string]*http.Client{}
	for _, p := range providers {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.DisableCompression = true
		transport.ForceAttemptHTTP2 = true
		transport.MaxIdleConnsPerHost = 2
		clients[p] = &http.Client{Transport: transport, Timeout: time.Duration(c.TimeoutSec) * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		defer transport.CloseIdleConnections()
	}
	var priorTrial Trial
	havePrevious := false
	rate := map[string]int{}
	for _, t := range s {
		if t.Session != session {
			continue
		}
		if _, ok := done[t.Key]; ok {
			continue
		}
		if havePrevious && c.TransitionPauseMS > 0 && pauseAtTransition(priorTrial, t) {
			time.Sleep(time.Duration(c.TransitionPauseMS) * time.Millisecond)
		}
		priorTrial, havePrevious = t, true
		r := recordRequest(context.Background(), clients[t.Provider], c, f, t, keys[t.Provider])
		b, _ := json.Marshal(r)
		if _, e = file.Write(append(b, '\n')); e != nil {
			return e
		}
		if e = file.Sync(); e != nil {
			return e
		}
		done[t.Key] = r
		fmt.Printf("%s status=%d total=%.1fms %s\n", t.Key, r.Status, r.TotalMS, r.Error)
		if r.Status == 401 || r.Status == 403 {
			return fmt.Errorf("%s credentials rejected; stopped after recording failure", t.Provider)
		}
		if r.Status == 400 || r.Status == 402 || r.Status == 404 || r.Status == 422 {
			return fmt.Errorf("%s returned HTTP %d; stopped after recording failure", t.Provider, r.Status)
		}
		if r.Status == 429 {
			rate[t.Provider]++
			if t.Provider != "vercel" && rate[t.Provider] >= 3 {
				return fmt.Errorf("%s returned three consecutive 429s; stopped", t.Provider)
			}
		} else {
			rate[t.Provider] = 0
		}
	}
	return nil
}
func median(xs []float64) float64 {
	if len(xs) == 0 {
		return math.NaN()
	}
	a := append([]float64{}, xs...)
	sort.Float64s(a)
	n := len(a)
	if n%2 == 1 {
		return a[n/2]
	}
	return (a[n/2-1] + a[n/2]) / 2
}
func quantile(xs []float64, p float64) float64 {
	if len(xs) == 0 {
		return math.NaN()
	}
	a := append([]float64{}, xs...)
	sort.Float64s(a)
	idx := p * float64(len(a)-1)
	lo := int(idx)
	hi := int(math.Ceil(idx))
	return a[lo] + (a[hi]-a[lo])*(idx-float64(lo))
}
func bootstrap(pairs [][2]float64, seed int64) (float64, float64) {
	rng := rand.New(rand.NewSource(seed))
	vals := make([]float64, 2000)
	for b := range vals {
		direct := make([]float64, len(pairs))
		gateway := make([]float64, len(pairs))
		for j := range pairs {
			k := rng.Intn(len(pairs))
			direct[j] = pairs[k][0]
			gateway[j] = pairs[k][1]
		}
		vals[b] = median(gateway) - median(direct)
	}
	return quantile(vals, .025), quantile(vals, .975)
}
func writeCSV(path string, head []string, rows [][]string) error {
	f, e := os.Create(path)
	if e != nil {
		return e
	}
	defer f.Close()
	w := csv.NewWriter(f)
	if e = w.Write(head); e != nil {
		return e
	}
	if e = w.WriteAll(rows); e != nil {
		return e
	}
	w.Flush()
	return w.Error()
}
func num(x float64) string {
	if math.IsNaN(x) {
		return "NA"
	}
	return fmt.Sprintf("%.2f", x)
}
func report(out string, c Config, s []Trial) error {
	m, e := readManifest(out)
	if e != nil {
		return e
	}
	a, _ := json.Marshal(m.Config)
	b, _ := json.Marshal(c)
	if !bytes.Equal(a, b) || m.ScheduleHash != scheduleHash(s) {
		return errors.New("report flags differ from manifest")
	}
	records, e := loadRecords(out)
	if e != nil {
		return e
	}
	summary := [][]string{}
	pairsRows := [][]string{}
	dnfRows := [][]string{}
	dnfCounts := map[string]int{}
	for _, trial := range s {
		r, observed := records[trial.Key]
		if !observed || r.Error == "" {
			continue
		}
		rateLimit, _ := json.Marshal(r.RateLimit)
		dnfRows = append(dnfRows, []string{r.Key, r.Provider, r.Primitive, strconv.Itoa(r.Batch), strconv.Itoa(r.Rep), strconv.Itoa(r.Session), strconv.Itoa(r.Status), strconv.FormatBool(r.Timeout), r.Error, r.ErrorBody, r.RetryAfter, string(rateLimit), num(r.TotalMS)})
		dnfCounts[fmt.Sprintf("%s/HTTP %d", r.Provider, r.Status)]++
	}
	var md strings.Builder
	fmt.Fprintf(&md, "# Jev client-observed latency\n\nRun created %s at %s (%s, %s). Schedule `%s`.\n\n", m.Created, m.Hostname, m.Location, m.GoVersion, m.ScheduleHash)
	fmt.Fprintf(&md, "Total records: %d / %d planned. Durations are full requests in ms, from this measured location.\n\n", len(records), len(s))
	fmt.Fprintf(&md, "Fixture: `%s` (SHA-256 `%s`). Each configuration has %d repetitions split across two sessions. Requests ran one at a time, with seeded balanced provider order within each matched trial. The 16-question mixed cell contains 6 Noul, 5 Choice, and 5 Score questions.\n\n", c.Fixture, c.FixtureHash, c.Reps)
	if c.SampleTag != "" {
		fmt.Fprintf(&md, "Sample tag: `%s`. A fixed-width `state.benchmark_sample_id` varied by repetition and matched across providers; the report evidence and question meanings stayed fixed. This avoids identical request bodies within a cell but cannot rule out internal caching.\n\n", c.SampleTag)
	}
	fmt.Fprintln(&md, "| Provider | Primitive | Batch | OK / planned | Fail rate | Timeout rate | New / reused connections | p50 ms | rough p95 ms |")
	fmt.Fprintln(&md, "|---|---|---:|---:|---:|---:|---:|---:|---:|")
	for _, p := range selectedPrimitives(c) {
		for _, batch := range c.Batches {
			if !includeCell(p, batch) {
				continue
			}
			for _, provider := range providers {
				var vals []float64
				fails, timeouts, observed, fresh, reused := 0, 0, 0, 0, 0
				for _, t := range s {
					if t.Primitive != p || t.Batch != batch || t.Provider != provider {
						continue
					}
					if r, ok := records[t.Key]; ok {
						observed++
						if r.Error == "" {
							vals = append(vals, r.TotalMS)
						} else {
							fails++
						}
						if r.Timeout {
							timeouts++
						}
						if r.Reused != nil {
							if *r.Reused {
								reused++
							} else {
								fresh++
							}
						}
					}
				}
				planned := c.Reps
				failRate, timeoutRate := math.NaN(), math.NaN()
				if observed > 0 {
					failRate = 100 * float64(fails) / float64(observed)
					timeoutRate = 100 * float64(timeouts) / float64(observed)
				}
				row := []string{provider, p, strconv.Itoa(batch), strconv.Itoa(len(vals)), strconv.Itoa(observed), strconv.Itoa(planned), strconv.Itoa(fails), strconv.Itoa(timeouts), num(failRate), num(timeoutRate), strconv.Itoa(fresh), strconv.Itoa(reused), num(median(vals)), num(quantile(vals, .95))}
				summary = append(summary, row)
				fmt.Fprintf(&md, "| %s | %s | %d | %d / %d | %s%% | %s%% | %d / %d | %s | %s |\n", provider, p, batch, len(vals), planned, num(failRate), num(timeoutRate), fresh, reused, num(median(vals)), num(quantile(vals, .95)))
			}
		}
	}
	fmt.Fprint(&md, "\n## Matched gateway comparisons\n\n")
	fmt.Fprintln(&md, "| Gateway | Primitive | Batch | Complete pairs | Missing / failed pairs | Different answer payloads | Difference of medians ms | Median paired difference ms | Median delta % | 95% paired bootstrap CI ms |")
	fmt.Fprintln(&md, "|---|---|---:|---:|---:|---:|---:|---:|---:|---|")
	for _, p := range selectedPrimitives(c) {
		for _, batch := range c.Batches {
			if !includeCell(p, batch) {
				continue
			}
			for _, gateway := range []string{"vercel", "openrouter"} {
				var pair [][2]float64
				missing, failed, different := 0, 0, 0
				for rep := 0; rep < c.Reps; rep++ {
					block := fmt.Sprintf("%s/%d/%03d", p, batch, rep)
					d, dok := records[block+"/typesafe"]
					g, gok := records[block+"/"+gateway]
					if !dok || !gok {
						missing++
						continue
					}
					if d.Error != "" || g.Error != "" {
						failed++
						continue
					}
					if !bytes.Equal(d.Answers, g.Answers) {
						different++
					}
					pair = append(pair, [2]float64{d.TotalMS, g.TotalMS})
				}
				var dv, gv, delta, pct []float64
				for _, z := range pair {
					dv = append(dv, z[0])
					gv = append(gv, z[1])
					delta = append(delta, z[1]-z[0])
					if z[0] > 0 {
						pct = append(pct, (z[1]-z[0])/z[0]*100)
					}
				}
				diff := median(gv) - median(dv)
				lo, hi := math.NaN(), math.NaN()
				if len(pair) >= 20 {
					lo, hi = bootstrap(pair, c.Seed+int64(batch)*100+int64(len(p)))
				}
				pairsRows = append(pairsRows, []string{gateway, p, strconv.Itoa(batch), strconv.Itoa(len(pair)), strconv.Itoa(missing), strconv.Itoa(failed), strconv.Itoa(different), num(diff), num(median(delta)), num(median(pct)), num(lo), num(hi)})
				fmt.Fprintf(&md, "| %s | %s | %d | %d | %d / %d | %d | %s | %s | %s | %s to %s |\n", gateway, p, batch, len(pair), missing, failed, different, num(diff), num(median(delta)), num(median(pct)), num(lo), num(hi))
			}
		}
	}
	fmt.Fprint(&md, "\nCI is shown only for at least 20 complete matched blocks; otherwise NA means insufficient samples. Bootstrap resamples matched blocks and the interval applies to the difference of route medians, not the median paired difference. Missing and failed trials are never replaced. Percent is the median of per-pair gateway-minus-direct divided by direct. Different answer payloads include probability and confidence differences; this is not an accuracy measure.\n")
	fmt.Fprintf(&md, "\n## DNF — attempted requests without valid answers\n\n%d DNF records. They remain in the raw results, count toward failure rates, and are excluded from latency medians and paired deltas. Unattempted scheduled requests are listed separately as missing pairs above. Every DNF is itemized in `dnf.csv`.\n\n", len(dnfRows))
	fmt.Fprintln(&md, "| Route / status | Count |")
	fmt.Fprintln(&md, "|---|---:|")
	var dnfKinds []string
	for kind := range dnfCounts {
		dnfKinds = append(dnfKinds, kind)
	}
	sort.Strings(dnfKinds)
	for _, kind := range dnfKinds {
		fmt.Fprintf(&md, "| %s | %d |\n", kind, dnfCounts[kind])
	}
	if len(dnfKinds) == 0 {
		fmt.Fprintln(&md, "| None | 0 |")
	}
	limits := map[string]int{}
	noProviderAttempt := 0
	for _, r := range records {
		if r.Provider != "vercel" || r.Status != 429 {
			continue
		}
		if v := r.RateLimit["X-Ratelimit-Limit-Requests"]; v != "" {
			limits[v]++
		}
		var detail struct {
			ProviderMetadata struct {
				Gateway struct {
					Routing struct {
						TotalProviderAttemptCount *int `json:"totalProviderAttemptCount"`
					} `json:"routing"`
				} `json:"gateway"`
			} `json:"providerMetadata"`
		}
		if json.Unmarshal([]byte(r.ErrorBody), &detail) == nil && detail.ProviderMetadata.Gateway.Routing.TotalProviderAttemptCount != nil && *detail.ProviderMetadata.Gateway.Routing.TotalProviderAttemptCount == 0 {
			noProviderAttempt++
		}
	}
	if len(limits) != 0 {
		var labels []string
		for limit, n := range limits {
			labels = append(labels, fmt.Sprintf("%s on %d responses", limit, n))
		}
		sort.Strings(labels)
		fmt.Fprintf(&md, "\nVercel 429 request-limit headers: %s. Gateway metadata reported zero upstream provider attempts on %d Vercel 429 responses. These identify a limit on this gateway route but do not establish which account tier or upstream allocation set it.\n", strings.Join(labels, ", "), noProviderAttempt)
	}
	fmt.Fprint(&md, "\nSuccessful-only latencies are conditionally selected when a route has many failures. Repeated input may be cached. Consult raw cache headers and usage; absent evidence does not prove no caching. Models may resolve differently or remain undisclosed. Gateway deltas include routing, provider service, network, and client-observed transfer and validation, and are not pure router overhead. This benchmark does not establish accuracy or a per-question latency.\n")
	if e = writeCSV(filepath.Join(out, "summary.csv"), []string{"provider", "primitive", "batch", "ok", "observed", "planned", "failures", "timeouts", "failure_rate_pct", "timeout_rate_pct", "new_connections", "reused_connections", "p50_ms", "rough_p95_ms"}, summary); e != nil {
		return e
	}
	if e = writeCSV(filepath.Join(out, "pairs.csv"), []string{"gateway", "primitive", "batch", "complete_pairs", "missing_pairs", "failed_pairs", "different_answer_payload_pairs", "difference_of_medians_ms", "median_paired_delta_ms", "median_paired_delta_pct", "difference_of_medians_bootstrap_low_ms", "difference_of_medians_bootstrap_high_ms"}, pairsRows); e != nil {
		return e
	}
	if e = writeCSV(filepath.Join(out, "dnf.csv"), []string{"key", "provider", "primitive", "batch", "repetition", "session", "http_status", "timeout", "error", "error_body", "retry_after", "rate_limit_headers", "total_ms"}, dnfRows); e != nil {
		return e
	}
	return os.WriteFile(filepath.Join(out, "report.md"), []byte(md.String()), 0600)
}
func main() {
	if len(os.Args) < 2 {
		fatal(errors.New("usage: jev-latency dry-run|run|report [flags]"))
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	out := fs.String("out", "results/triage", "output directory")
	session := fs.Int("session", 0, "session 1 or 2 (run only)")
	c, f, s, e := setup(fs, os.Args[2:])
	fatal(e)
	switch cmd {
	case "dry-run":
		fatal(dryRun(c, f, s))
	case "run":
		fatal(run(*out, *session, c, f, s))
	case "report":
		fatal(report(*out, c, s))
	default:
		fatal(fmt.Errorf("unknown command %q", cmd))
	}
}
