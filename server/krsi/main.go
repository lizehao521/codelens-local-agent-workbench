// krsi —— 跨代改进对账内核（R1-R6）。
//
// 契约（与 CodeLens 侧 RsiBridgeService 对齐）：
//
//	krsi <prev.json> <next.json> <report.txt> <ledger.jsonl>
//
// 退出码：
//
//	0 = improved      所有目标指标严格变好，且没有护栏指标变差
//	1 = not_improved  有目标指标没变好，或护栏指标变差
//	2 = refused       拒收：schema/判据/锚定/账本完整性不通过
//	3 = undecidable   没有可比目标指标，量不到
//
// 设计立场（这是与「LLM 自评式 RSI」的根本区别）：
//   - 判定只依赖两代 manifest 的**实测读数**，不调用任何模型；
//   - 判据集用内容指纹锚定，偷改判据必须显式声明，否则整代拒收；
//   - 读数不许减少（不许把难看的指标删掉来"变好"）；
//   - 产物必须能被内容哈希复核；
//   - 账本是哈希链，同一代出现两份不同 manifest 即拒收。
package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ── Manifest 结构 ────────────────────────────────────────────────────────

type Artifact struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type CriterionDiff struct {
	ID     string `json:"id"`
	Change string `json:"change"`
	Note   string `json:"note,omitempty"`
}

type Reading struct {
	Metric      string   `json:"metric"`
	N           float64  `json:"n"`
	Basis       int      `json:"basis"`
	Source      string   `json:"source,omitempty"`
	WhyAbsent   string   `json:"why_absent,omitempty"`
	Direction   string   `json:"direction"`
	Denominator *float64 `json:"denominator,omitempty"`
	// Role：objective = 必须严格变好；guard = 不得变差（缺省 objective）。
	// 护栏指标天生有天花板（成功率 100%、覆盖率 100%），到了顶就不可能再"严格变好"，
	// 把它们当目标会让 R5 永远判不出 improved —— 那是角色错配，不是没进步。
	Role string `json:"role,omitempty"`
}

type Manifest struct {
	Producer       string          `json:"producer"`
	Generation     int             `json:"generation"`
	Artifacts      []Artifact      `json:"artifacts"`
	CriteriaSHA256 string          `json:"criteria_sha256"`
	CriteriaDiff   []CriterionDiff `json:"criteria_diff"`
	Readings       []Reading       `json:"readings"`
	Claim          string          `json:"claim"`
}

const (
	exitImproved     = 0
	exitNotImproved  = 1
	exitRefused      = 2
	exitUndecidable  = 3
	criteriaDeclared = "R1 R2 R3 R4 R5 R6"
)

// ── 账本 ────────────────────────────────────────────────────────────────

type ledgerRow struct {
	Seq           int    `json:"seq"`
	Session       string `json:"session"`
	Actor         string `json:"actor"`
	Step          int    `json:"step,omitempty"`
	Kind          string `json:"kind"`
	Claim         string `json:"claim"`
	Basis         int    `json:"basis"`
	Source        string `json:"source,omitempty"`
	TS            string `json:"ts"`
	PayloadB64    string `json:"payload_b64,omitempty"`
	PayloadSHA256 string `json:"payload_sha256,omitempty"`
	PrevHash      string `json:"prev_hash"`
	Hash          string `json:"hash,omitempty"`
}

type gateRow struct {
	Gate struct {
		Rejected         int `json:"rejected"`
		PrecheckRejected int `json:"precheck_rejected"`
		PrecheckDoor     int `json:"precheck_door"`
		DoorRefused      int `json:"door_refused"`
		BadRequests      int `json:"bad_requests"`
		TransportRefused int `json:"transport_refused"`
		State            int `json:"state"`
	} `json:"gate"`
	ChainHead   string `json:"chain_head"`
	GateSHA256  string `json:"gate_sha256"`
	GateVersion int    `json:"gate_version"`
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func rowHash(prev string, payloadSHA string) string {
	return sha256Hex([]byte(prev + "|" + payloadSHA))
}

func loadLedger(path string) ([]ledgerRow, []gateRow, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	var rows []ledgerRow
	var gates []gateRow
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var probe map[string]json.RawMessage
		if json.Unmarshal([]byte(line), &probe) != nil {
			continue
		}
		if _, ok := probe["gate"]; ok {
			var g gateRow
			if json.Unmarshal([]byte(line), &g) == nil {
				gates = append(gates, g)
			}
			continue
		}
		var r ledgerRow
		if json.Unmarshal([]byte(line), &r) == nil {
			rows = append(rows, r)
		}
	}
	return rows, gates, nil
}

// appendRows 追加并维护 prev_hash/hash 链，返回链头与总条数。
func appendRows(path string, rows []ledgerRow) (string, int, error) {
	existing, _, err := loadLedger(path)
	if err != nil {
		return "", 0, err
	}
	head := ""
	seq := 0
	if n := len(existing); n > 0 {
		head = existing[n-1].Hash
		seq = existing[n-1].Seq
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	for i := range rows {
		seq++
		rows[i].Seq = seq
		rows[i].PrevHash = head
		rows[i].Hash = rowHash(head, rows[i].PayloadSHA256)
		head = rows[i].Hash
		b, _ := json.Marshal(rows[i])
		if _, err := f.Write(append(b, '\n')); err != nil {
			return head, seq, err
		}
	}
	return head, seq, nil
}

func makeRow(actor, kind, claim string, basis int, source string, payload []byte, step int) ledgerRow {
	body := base64.StdEncoding.EncodeToString(payload)
	return ledgerRow{
		Session:       "rsi",
		Actor:         actor,
		Step:          step,
		Kind:          kind,
		Claim:         claim,
		Basis:         basis,
		Source:        source,
		TS:            time.Now().UTC().Format(time.RFC3339Nano),
		PayloadB64:    body,
		PayloadSHA256: sha256Hex(payload),
	}
}

// ── 判据 ────────────────────────────────────────────────────────────────

var hex64 = func(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// R1：两份 manifest 都必须可解、schema 合法。
func checkR1(m Manifest, who string) string {
	if m.Producer == "" {
		return fmt.Sprintf("%s 缺少 producer", who)
	}
	if m.Generation < 0 {
		return fmt.Sprintf("%s generation 非法：%d", who, m.Generation)
	}
	for _, r := range m.Readings {
		if r.Metric == "" {
			return fmt.Sprintf("%s 存在空 metric", who)
		}
		if r.Basis < 1 || r.Basis > 5 {
			return fmt.Sprintf("%s 指标 %q 的 basis=%d 越界（1-5）", who, r.Metric, r.Basis)
		}
		if r.Direction != "up" && r.Direction != "down" {
			return fmt.Sprintf("%s 指标 %q 的 direction=%q 必须是 up/down", who, r.Metric, r.Direction)
		}
		if r.Basis == 4 && r.Source == "" {
			return fmt.Sprintf("%s 指标 %q basis=4(model_says) 必须带 source", who, r.Metric)
		}
		if r.Basis == 5 && r.WhyAbsent == "" {
			return fmt.Sprintf("%s 指标 %q basis=5(absent) 必须带 why_absent", who, r.Metric)
		}
		if r.Denominator != nil && *r.Denominator <= 0 {
			return fmt.Sprintf("%s 指标 %q denominator 必须为正", who, r.Metric)
		}
	}
	return ""
}

// R2：判据集必须显式锚定 —— 指纹变了却声明"没改判据"，就是偷改判据。
func checkR2(prev, next Manifest) string {
	if prev.CriteriaSHA256 == next.CriteriaSHA256 {
		return ""
	}
	if len(next.CriteriaDiff) == 0 {
		return "判据指纹变了（criteria_sha256 不一致）却没有 criteria_diff 声明：拒绝静默改判据"
	}
	for _, d := range next.CriteriaDiff {
		if d.ID == "" {
			return "criteria_diff 存在空 id"
		}
		switch d.Change {
		case "tightened", "loosened", "added", "removed":
		default:
			return fmt.Sprintf("criteria_diff %q 的 change=%q 非法", d.ID, d.Change)
		}
	}
	return ""
}

// R3：防放水 —— 不许通过删指标来"变好"。
func checkR3(prev, next Manifest) string {
	nextSet := map[string]bool{}
	for _, r := range next.Readings {
		nextSet[r.Metric] = true
	}
	var dropped []string
	for _, r := range prev.Readings {
		if !nextSet[r.Metric] {
			dropped = append(dropped, r.Metric)
		}
	}
	if len(dropped) > 0 {
		sort.Strings(dropped)
		return fmt.Sprintf("上一代有、这一代消失的指标：%s（删指标不等于变好）", strings.Join(dropped, ", "))
	}
	return ""
}

// R4：产物必须能被内容哈希复核。
func checkR4(m Manifest, who string) string {
	for _, a := range m.Artifacts {
		if !hex64(a.SHA256) {
			return fmt.Sprintf("%s 产物 %q 的 sha256 不是 64 位十六进制", who, a.Path)
		}
		if a.Bytes < 0 {
			return fmt.Sprintf("%s 产物 %q 的 bytes 为负", who, a.Path)
		}
		if a.Path == "" {
			continue
		}
		// 文件存在就复核内容；不存在只校验格式（产物可能在另一台机器上）。
		if b, err := os.ReadFile(a.Path); err == nil {
			if got := sha256Hex(b); got != a.SHA256 {
				return fmt.Sprintf("%s 产物 %q 内容哈希不符：声明 %s，实际 %s", who, a.Path, a.SHA256[:12], got[:12])
			}
			if a.Bytes > 0 && int64(len(b)) != a.Bytes {
				return fmt.Sprintf("%s 产物 %q 字节数不符：声明 %d，实际 %d", who, a.Path, a.Bytes, len(b))
			}
		}
	}
	return ""
}

// R6：同一代不得在链上出现两份不同 manifest。
func checkR6(ledgerPath string, next Manifest) string {
	rows, _, err := loadLedger(ledgerPath)
	if err != nil {
		return ""
	}
	nextHash := sha256Hex(mustJSON(next))
	for _, r := range rows {
		if r.Kind != "rsi_generation" || r.Actor != next.Producer {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(r.PayloadB64)
		if err != nil {
			continue
		}
		var m Manifest
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		if m.Generation != next.Generation {
			continue
		}
		if sha256Hex(raw) != nextHash && sha256Hex(mustJSON(m)) != nextHash {
			return fmt.Sprintf("%s 第 %d 代已有一份不同的 manifest 在链上，重记被拒", next.Producer, next.Generation)
		}
	}
	return ""
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// ── R5：严格比较 ────────────────────────────────────────────────────────

type metricLine struct {
	Metric string
	Before float64
	After  float64
	Better bool
	Role   string
}

// compare 把两代可比指标分成两组：
//   - objective（目标）：必须严格变好，objectiveStrict 统计变好的个数
//   - guard（护栏）：只要不变差即可，guardRegressed 统计变差的个数
//
// 两组都要求「方向一致」才可比；方向不一致的指标直接跳过（不参与判定）。
func compare(prev, next Manifest) (out []metricLine, objectiveStrict, objectiveCount, guardRegressed int) {
	byPrev := map[string]Reading{}
	for _, r := range prev.Readings {
		byPrev[r.Metric] = r
	}
	for _, n := range next.Readings {
		p, ok := byPrev[n.Metric]
		if !ok {
			continue
		}
		if p.Direction != n.Direction {
			continue
		}
		// 两代都量不到（basis=5）→ 这一对不可比，不参与判定；
		// 只有一侧量不到时仍参与：目标指标"这一代量不到"不能被当成变好。
		if p.Basis == 5 && n.Basis == 5 {
			continue
		}
		role := n.Role
		if role == "" {
			role = "objective"
		}
		better := false
		if n.Direction == "up" {
			better = n.N > p.N
		} else {
			better = n.N < p.N
		}
		line := metricLine{Metric: n.Metric, Before: p.N, After: n.N, Better: better, Role: role}
		if role == "guard" {
			// 护栏的"达标"= 没变差；持平可以，变差不行。
			ok := n.N >= p.N
			if n.Direction == "down" {
				ok = n.N <= p.N
			}
			line.Better = ok
			if !ok {
				guardRegressed++
			}
		} else {
			objectiveCount++
			if better {
				objectiveStrict++
			}
		}
		out = append(out, line)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Metric < out[j].Metric })
	return out, objectiveStrict, objectiveCount, guardRegressed
}

func fmtNum(f float64) string {
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.6f", f), "0"), ".")
}

/**
 * 目标指标是否已经饱和：所有目标指标都没变好，且都已经顶在 1.0。
 *
 * 饱和 ≠ 退步，也 ≠ 没进步。它是「这组题已经考不出差距」——
 * 此时如实判 undecidable，不要逼出一个"为什么没变好"的理由。
 */
func atCeiling(metrics []metricLine) bool {
	seen := false
	for _, m := range metrics {
		if m.Role == "guard" {
			continue
		}
		seen = true
		if m.Better {
			return false // 还有目标在变好 → 走 improved 分支
		}
		if m.After < 1 {
			return false // 还有上升空间 → 真的没做好
		}
	}
	return seen
}

// ── 主流程 ──────────────────────────────────────────────────────────────

func main() {
	if len(os.Args) != 5 {
		fmt.Fprintln(os.Stderr, "用法: krsi <上一代.json> <这一代.json> <报告.txt> <账本.jsonl>")
		os.Exit(exitRefused)
	}
	prevPath, nextPath, reportPath, ledgerPath := os.Args[1], os.Args[2], os.Args[3], os.Args[4]

	prevRaw, err := os.ReadFile(prevPath)
	if err != nil {
		fail(reportPath, exitRefused, fmt.Sprintf("%s 读不到：%v", prevPath, err))
	}
	nextRaw, err := os.ReadFile(nextPath)
	if err != nil {
		fail(reportPath, exitRefused, fmt.Sprintf("%s 读不到：%v", nextPath, err))
	}

	var prev, next Manifest
	if err := json.Unmarshal(prevRaw, &prev); err != nil {
		fail(reportPath, exitRefused, fmt.Sprintf("%s 解不开：%v", prevPath, err))
	}
	if err := json.Unmarshal(nextRaw, &next); err != nil {
		fail(reportPath, exitRefused, fmt.Sprintf("%s 解不开：%v", nextPath, err))
	}

	// 判据按固定顺序执行；任一条拒收，整代拒收。
	refuse := ""
	refusedBy := ""
	if m := checkR1(prev, "上一代"); m != "" {
		refuse, refusedBy = m, "R1"
	}
	if refuse == "" {
		if m := checkR1(next, "这一代"); m != "" {
			refuse, refusedBy = m, "R1"
		}
	}
	if refuse == "" {
		if m := checkR2(prev, next); m != "" {
			refuse, refusedBy = m, "R2"
		}
	}
	if refuse == "" {
		if m := checkR3(prev, next); m != "" {
			refuse, refusedBy = m, "R3"
		}
	}
	if refuse == "" {
		if m := checkR4(next, "这一代"); m != "" {
			refuse, refusedBy = m, "R4"
		}
	}
	if refuse == "" {
		if m := checkR6(ledgerPath, next); m != "" {
			refuse, refusedBy = m, "R6"
		}
	}

	metrics, objectiveStrict, objectiveCount, guardRegressed := compare(prev, next)

	// 账本：先把两代 manifest 记上链，再记判决。
	var rows []ledgerRow
	rows = append(rows, makeRow("codelens-agentkernel", "rsi_generation",
		fmt.Sprintf("Agent 第 %d 代判据塔判决", prev.Generation), 2, prev.Producer, prevRaw, prev.Generation))
	rows = append(rows, makeRow("codelens-agentkernel", "rsi_generation",
		fmt.Sprintf("Agent 第 %d 代判据塔判决", next.Generation), 2, next.Producer, nextRaw, next.Generation))

	exit := exitImproved
	verdict := "improved"
	var reasons []string
	switch {
	case refuse != "":
		exit, verdict = exitRefused, "refused"
		reasons = append(reasons, fmt.Sprintf("%s: %s", refusedBy, refuse))
	case len(metrics) == 0:
		exit, verdict = exitUndecidable, "undecidable"
		reasons = append(reasons, "R5: 两代没有可比指标，量不到改进")
	case objectiveCount == 0:
		exit, verdict = exitUndecidable, "undecidable"
		reasons = append(reasons, "R5: 只有护栏指标、没有目标指标 —— 护栏不变差只能说明没退步，说明不了能力提升")
	case guardRegressed > 0:
		exit, verdict = exitNotImproved, "not_improved"
		for _, m := range metrics {
			if m.Role == "guard" && !m.Better {
				reasons = append(reasons, fmt.Sprintf("R5: 护栏指标 %q 变差（%s → %s）", m.Metric, fmtNum(m.Before), fmtNum(m.After)))
			}
		}
	case atCeiling(metrics):
		// 目标指标已经顶到 1.0，两代之间不可能再"严格变好"。
		// 这时判 not_improved 是错的：它不是"退步"，而是"这组题已经考不出差距"。
		// 按读本铁律——饱和意味着该扩任务空间、加新家族，而不是改判据让它继续绿。
		// 记 undecidable（诚实的"无法再证明"），避免归因器编造一条"为什么没变好"的假教训。
		exit, verdict = exitUndecidable, "undecidable"
		reasons = append(reasons, "R5: 目标指标已达上限（1.0），本任务族已饱和 —— 没有可提升空间；应扩任务空间而不是改判据")
	case objectiveStrict < objectiveCount:
		exit, verdict = exitNotImproved, "not_improved"
		for _, m := range metrics {
			if m.Role != "guard" && !m.Better {
				reasons = append(reasons, fmt.Sprintf("R5: 目标指标 %q 没变好（%s → %s）", m.Metric, fmtNum(m.Before), fmtNum(m.After)))
			}
		}
	}

	verdictPayload, _ := json.Marshal(map[string]any{
		"state":   verdict,
		"reasons": reasons,
		"metrics": metrics,
	})
	rows = append(rows, makeRow("krsi", "rsi_verdict",
		fmt.Sprintf("%s：%d 条理由、%d 个指标（详见原像）", verdict, len(reasons), len(metrics)),
		1, "", verdictPayload, next.Generation))

	head, chainLen, err := appendRows(ledgerPath, rows)
	if err != nil {
		fail(reportPath, exitRefused, fmt.Sprintf("账本写入失败：%v", err))
	}

	// gate 行：把本次判决的闸口统计与链头一起钉住。
	var gate gateRow
	gate.ChainHead = head
	gate.GateSHA256 = sha256Hex([]byte(fmt.Sprintf("%s|%s|%d", head, verdict, exit)))
	gate.GateVersion = 2
	gate.Gate.State = 1
	gb, _ := json.Marshal(gate)
	if f, err := os.OpenFile(ledgerPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
		f.Write(append(gb, '\n'))
		f.Close()
	}

	// 报告
	anchor := fmt.Sprintf("链上 %d 条，Verify 过，口径=这一程完整可数", chainLen)
	if exit == exitRefused {
		anchor = "锚定被拒"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "两代改进对账 · krsi\n")
	fmt.Fprintf(&b, "生产者 %s：第 %d 代 → 第 %d 代\n", next.Producer, prev.Generation, next.Generation)
	fmt.Fprintf(&b, "判据目录：声明 6 条 [%s] ／ 实现 6 条 [%s]\n", criteriaDeclared, criteriaDeclared)
	fmt.Fprintf(&b, "读数：上一代 %d 条；这一代 %d 条\n", countMeasured(prev), countMeasured(next))
	fmt.Fprintf(&b, "指标：比到 %d 个（目标 %d 个 / 护栏 %d 个），目标严格变好 %d 个\n", len(metrics), objectiveCount, len(metrics)-objectiveCount, objectiveStrict)
	for _, m := range metrics {
		tag := ""
		if m.Role == "guard" {
			tag = "（护栏：不得变差）"
		}
		fmt.Fprintf(&b, "  · %s：%s → %s（变好=%t）%s\n", m.Metric, fmtNum(m.Before), fmtNum(m.After), m.Better, tag)
	}
	fmt.Fprintf(&b, "判定：%s\n", verdict)
	if len(reasons) == 0 {
		fmt.Fprintf(&b, "理由：（无 —— 全部指标严格变好）\n")
	} else {
		for _, r := range reasons {
			fmt.Fprintf(&b, "理由：%s\n", r)
		}
	}
	fmt.Fprintf(&b, "锚定：%s\n", anchor)
	fmt.Fprintf(&b, "退出码：%d（0=算数 1=不算数 2=拒收 3=核不了）\n", exit)
	fmt.Fprintf(&b, "边界：只答「读数支不支持改进声明」；判据集由生产者交，R3 防放水、不防判据本来就错。\n")

	_ = os.MkdirAll(filepath.Dir(reportPath), 0o755)
	if err := os.WriteFile(reportPath, []byte(b.String()), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "报告写不出：", err)
	}
	os.Exit(exit)
}

func countMeasured(m Manifest) int {
	n := 0
	for _, r := range m.Readings {
		if r.Basis >= 1 && r.Basis <= 3 {
			n++
		}
	}
	return n
}

// fail 在连账本都写不了的最早期错误上，仍尽量留一份可读报告。
func fail(reportPath string, code int, msg string) {
	_ = os.MkdirAll(filepath.Dir(reportPath), 0o755)
	_ = os.WriteFile(reportPath, []byte("两代改进对账 · krsi\n判定：refused\n理由："+msg+"\n退出码：2（0=算数 1=不算数 2=拒收 3=核不了）\n"), 0o644)
	os.Exit(code)
}
