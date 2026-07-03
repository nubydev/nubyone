package handlers

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	rt "core/cmd/agent/runtime"
	"core/cmd/agent/wire"
)

type procInfo struct {
	PID  int    `msgpack:"pid"`
	Name string `msgpack:"name"`
	User string `msgpack:"user"`
	Mem  uint64 `msgpack:"mem"` // bytes (RSS)
}

func handleProcList(ctx context.Context, env *rt.Env, envelope map[string]interface{}) {
	reqId, _ := envelope["reqId"].(string)

	procs, err := listProcesses()
	resp := map[string]interface{}{
		"type":  "proc_list_result",
		"reqId": reqId,
		"ok":    err == nil,
	}
	if err != nil {
		resp["error"] = err.Error()
	} else {
		resp["procs"] = procs
	}
	if wErr := wire.WriteMsg(ctx, env.Conn, resp); wErr != nil {
		log.Printf("[proc_list] send result: %v", wErr)
	}
}

func handleProcKill(ctx context.Context, env *rt.Env, envelope map[string]interface{}) {
	reqId, _ := envelope["reqId"].(string)
	pid := intFromEnvelope(envelope, "pid")

	sendResult := func(ok bool, errMsg string) {
		resp := map[string]interface{}{
			"type":  "proc_kill_result",
			"reqId": reqId,
			"ok":    ok,
		}
		if errMsg != "" {
			resp["error"] = errMsg
		}
		if err := wire.WriteMsg(ctx, env.Conn, resp); err != nil {
			log.Printf("[proc_kill] send result: %v", err)
		}
	}

	if pid <= 0 {
		sendResult(false, "invalid PID")
		return
	}

	proc, err := os.FindProcess(pid)
	if err != nil {
		sendResult(false, fmt.Sprintf("find process: %v", err))
		return
	}
	// Kill sends SIGKILL on Unix and calls TerminateProcess on Windows.
	if err := proc.Kill(); err != nil {
		sendResult(false, fmt.Sprintf("kill: %v", err))
		return
	}

	log.Printf("[proc_kill] killed PID %d", pid)
	sendResult(true, "")
}

func listProcesses() ([]procInfo, error) {
	if runtime.GOOS == "windows" {
		return listProcessesWindows()
	}
	return listProcessesUnix()
}

// listProcessesWindows uses tasklist.exe /FO CSV /NH.
// CSV columns: "Image Name","PID","Session Name","Session#","Mem Usage"
func listProcessesWindows() ([]procInfo, error) {
	tctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(tctx, "tasklist.exe", "/FO", "CSV", "/NH").Output()
	if err != nil {
		return nil, fmt.Errorf("tasklist: %w", err)
	}
	var procs []procInfo
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := csvSplit(line)
		if len(parts) < 5 {
			continue
		}
		name := strings.Trim(parts[0], `"`)
		pidStr := strings.Trim(parts[1], `"`)
		memStr := strings.Trim(parts[4], `"`)
		pid, err := strconv.Atoi(pidStr)
		if err != nil {
			continue
		}
		// Memory field looks like "1,234 K" — strip non-digits, convert KB→bytes.
		var digits strings.Builder
		for _, r := range memStr {
			if r >= '0' && r <= '9' {
				digits.WriteRune(r)
			}
		}
		memKB, _ := strconv.ParseUint(digits.String(), 10, 64)
		procs = append(procs, procInfo{PID: pid, Name: name, Mem: memKB * 1024})
	}
	return procs, nil
}

// listProcessesUnix tries `ps ax -o pid=,rss=,user=,comm=` first;
// falls back to `ps aux` on minimal/busybox systems.
func listProcessesUnix() ([]procInfo, error) {
	tctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(tctx, "ps", "ax", "-o", "pid=,rss=,user=,comm=").Output()
	if err != nil {
		out, err = exec.CommandContext(tctx, "ps", "aux").Output()
		if err != nil {
			return nil, fmt.Errorf("ps: %w", err)
		}
		return parsePsAux(string(out)), nil
	}
	return parsePsCustom(string(out)), nil
}

func parsePsCustom(out string) []procInfo {
	var procs []procInfo
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil {
			continue
		}
		rssKB, _ := strconv.ParseUint(fields[1], 10, 64)
		user := fields[2]
		name := fields[3]
		if idx := strings.LastIndexByte(name, '/'); idx >= 0 {
			name = name[idx+1:]
		}
		procs = append(procs, procInfo{PID: pid, Name: name, User: user, Mem: rssKB * 1024})
	}
	return procs
}

func parsePsAux(out string) []procInfo {
	var procs []procInfo
	lines := strings.Split(out, "\n")
	if len(lines) < 2 {
		return procs
	}
	for _, line := range lines[1:] { // skip header row
		fields := strings.Fields(line)
		if len(fields) < 11 {
			continue
		}
		user := fields[0]
		pid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		rssKB, _ := strconv.ParseUint(fields[5], 10, 64) // RSS column in ps aux
		name := fields[10]
		if idx := strings.LastIndexByte(name, '/'); idx >= 0 {
			name = name[idx+1:]
		}
		procs = append(procs, procInfo{PID: pid, Name: name, User: user, Mem: rssKB * 1024})
	}
	return procs
}

// csvSplit splits one CSV line, honouring double-quoted fields that may
// contain commas (as tasklist.exe produces).
func csvSplit(line string) []string {
	var fields []string
	var cur strings.Builder
	inQ := false
	for _, c := range line {
		switch {
		case c == '"':
			inQ = !inQ
			cur.WriteRune(c)
		case c == ',' && !inQ:
			fields = append(fields, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(c)
		}
	}
	if cur.Len() > 0 {
		fields = append(fields, cur.String())
	}
	return fields
}
