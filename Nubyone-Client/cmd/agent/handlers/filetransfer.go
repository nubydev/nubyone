package handlers

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"

	rt "core/cmd/agent/runtime"
	"core/cmd/agent/wire"
)

const maxFileSize = 100 * 1024 * 1024 // 100 MB hard cap per transfer

func handleFilePush(ctx context.Context, env *rt.Env, envelope map[string]interface{}) {
	reqId, _ := envelope["reqId"].(string)
	destPath, _ := envelope["path"].(string)

	sendResult := func(ok bool, errMsg string) {
		resp := map[string]interface{}{
			"type":  "file_push_result",
			"reqId": reqId,
			"ok":    ok,
		}
		if errMsg != "" {
			resp["error"] = errMsg
		}
		if err := wire.WriteMsg(ctx, env.Conn, resp); err != nil {
			log.Printf("[file_push] send result: %v", err)
		}
	}

	if destPath == "" {
		sendResult(false, "destination path is required")
		return
	}

	var data []byte
	switch v := envelope["data"].(type) {
	case []byte:
		data = v
	case string:
		data = []byte(v)
	default:
		sendResult(false, "missing or invalid file data")
		return
	}

	if int64(len(data)) > maxFileSize {
		sendResult(false, fmt.Sprintf("file exceeds 100 MB limit (%.1f MB received)", float64(len(data))/1024/1024))
		return
	}

	// Ensure parent directory exists before writing.
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		sendResult(false, fmt.Sprintf("create directory: %v", err))
		return
	}

	// Write atomically: stage to a temp name, then rename into place so the
	// destination either contains the complete new file or the old one —
	// never a partial write.
	tmp := destPath + ".zctmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		sendResult(false, fmt.Sprintf("write file: %v", err))
		return
	}
	if err := os.Rename(tmp, destPath); err != nil {
		_ = os.Remove(tmp)
		sendResult(false, fmt.Sprintf("finalize: %v", err))
		return
	}

	log.Printf("[file_push] wrote %d bytes → %s", len(data), destPath)
	sendResult(true, "")
}

func handleFilePull(ctx context.Context, env *rt.Env, envelope map[string]interface{}) {
	reqId, _ := envelope["reqId"].(string)
	srcPath, _ := envelope["path"].(string)

	sendResult := func(ok bool, filename string, data []byte, size int64, errMsg string) {
		resp := map[string]interface{}{
			"type":     "file_pull_result",
			"reqId":    reqId,
			"ok":       ok,
			"filename": filename,
			"size":     size,
		}
		if data != nil {
			resp["data"] = data
		}
		if errMsg != "" {
			resp["error"] = errMsg
		}
		if err := wire.WriteMsg(ctx, env.Conn, resp); err != nil {
			log.Printf("[file_pull] send result: %v", err)
		}
	}

	if srcPath == "" {
		sendResult(false, "", nil, 0, "source path is required")
		return
	}

	info, err := os.Stat(srcPath)
	if err != nil {
		sendResult(false, "", nil, 0, fmt.Sprintf("stat: %v", err))
		return
	}
	if info.IsDir() {
		sendResult(false, "", nil, 0, "path is a directory — specify a file path")
		return
	}
	if info.Size() > maxFileSize {
		sendResult(false, "", nil, 0,
			fmt.Sprintf("file too large (%.1f MB, max 100 MB)", float64(info.Size())/1024/1024))
		return
	}

	f, err := os.Open(srcPath)
	if err != nil {
		sendResult(false, "", nil, 0, fmt.Sprintf("open: %v", err))
		return
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, maxFileSize+1))
	if err != nil {
		sendResult(false, "", nil, 0, fmt.Sprintf("read: %v", err))
		return
	}

	log.Printf("[file_pull] sending %d bytes ← %s", len(data), srcPath)
	sendResult(true, filepath.Base(srcPath), data, info.Size(), "")
}
