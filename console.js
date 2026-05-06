// Kolonus ESP32-C3 Console (Web Edition v1.2.0)
// https://github.com/freezerpack/kolonus-flasher-web
//
// Consola serial para hablar con el firmware del ESP32-C3 corriendo
// (NO download mode). Dos modos de transporte autodetectados:
//
//   - NATIVO (Web Serial API): Chrome desktop ≥89, Chrome Android ≥122.
//     port.readable.getReader() / port.writable.getWriter().
//
//   - WEBUSB DIRECTO: Chrome Android <122 (caso Konector V2 / Android 7).
//     navigator.usb + claimInterface + transferIn/transferOut.
//     NO usamos web-serial-polyfill porque tiene bug conocido:
//     "TypeError: Failed to execute 'enqueue' on 'ReadableByteStreamController':
//     chunk is empty" — el polyfill intenta inyectar paquetes vacíos al
//     ReadableStream cuando el USB-Serial-JTAG del C3 envía keep-alives.
//
// Comandos del firmware v1.3.8: VERSION?, ID?, MAC?, STATS?, RESTARTS?,
// WIFI?, WIFI,ssid,password, WIFI_CLEAR, PING_STATUS?, PING_ENABLE,
// PING_DISABLE, USB_RESET, RESET, RESTARTS_CLEAR, UART_TEST, HELP.
//
// Pre-requisito: el APK launcher debe haber liberado el cdc_acm vía
// "📡 Consola" antes de abrir esta página.

// ─── Config ─────────────────────────────────────────────────────────
const BAUD_RATE = 115200;  // En USB-CDC nativo del C3 es cosmético

// Filtros para Web Serial NATIVA (formato { usbVendorId })
const NATIVE_FILTERS = [
    { usbVendorId: 0x303a },  // Espressif (ESP32-C3 USB-JTAG nativo)
    { usbVendorId: 0x10c4 },  // CP210x (Silicon Labs)
    { usbVendorId: 0x1a86 },  // CH340 (WCH)
    { usbVendorId: 0x0403 },  // FTDI
];

// Filtros para WebUSB (formato { vendorId })
const WEBUSB_FILTERS = [
    { vendorId: 0x303a },
    { vendorId: 0x10c4 },
    { vendorId: 0x1a86 },
    { vendorId: 0x0403 },
];

// Códigos de clase USB
const CDC_DATA_CLASS = 0x0A;
const CDC_COMM_CLASS = 0x02;
const VENDOR_CLASS = 0xFF;

// Detección de transporte disponible
const hasNativeSerial = ('serial' in navigator);
const hasWebUSB = ('usb' in navigator);

// ─── Estado ─────────────────────────────────────────────────────────
let mode = null;  // 'native' o 'webusb'
let isConnected = false;
let term = null;
let fitAddon = null;
let cmdHistory = [];
let historyIndex = -1;
let readLoopAbort = null;

// Estado modo nativo
let port = null;        // SerialPort (Web Serial API)
let reader = null;
let writer = null;

// Estado modo WebUSB
let usbDevice = null;     // USBDevice
let usbInterface = null;  // número de interface CDC Data o vendor
let usbCommInterface = null;  // número de interface CDC Communication (para SET_CONTROL_LINE_STATE)
let usbEpIn = null;       // endpoint bulk IN
let usbEpOut = null;      // endpoint bulk OUT

// ─── DOM refs ───────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Compatibilidad ─────────────────────────────────────────────────
function checkCompatibility() {
    const banner = $('compatBanner');
    if (!hasNativeSerial && !hasWebUSB) {
        banner.style.display = 'block';
        banner.textContent = '❌ Tu navegador NO soporta Web Serial NI WebUSB. ' +
            'Usa Chrome, Edge u Opera (Chromium 61+).';
        $('btnConnect').disabled = true;
        return false;
    }
    return true;
}

// ─── Terminal helpers ───────────────────────────────────────────────
function initTerminal() {
    term = new Terminal({
        theme: {
            background: '#0a0a0a',
            foreground: '#e0e0e0',
            cursor: '#4fc3f7',
            selectionBackground: '#264f78',
        },
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 5000,
        convertEol: true,
        cursorBlink: true,
        disableStdin: true,
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open($('terminal'));
    fitAddon.fit();
    window.addEventListener('resize', () => fitAddon.fit());

    termWriteSystem('Kolonus Console v1.2 — Conecta al ESP32-C3 para empezar');
    termWriteSystem('Tecla ↑/↓ para navegar el historial · Enter para enviar');
}

function termWriteSystem(text) {
    if (!term) return;
    term.writeln('\x1b[90m' + text + '\x1b[0m');
}

function termWriteSent(text) {
    if (!term) return;
    term.writeln('\x1b[36m> ' + text + '\x1b[0m');
}

function termWriteRecv(text) {
    if (!term) return;
    if (text.startsWith('OK,')) {
        term.writeln('\x1b[32m' + text + '\x1b[0m');
    } else if (text.startsWith('ERR,')) {
        term.writeln('\x1b[31m' + text + '\x1b[0m');
    } else {
        term.writeln(text);
    }
}

// ─── UI helpers ─────────────────────────────────────────────────────
function updateStatus(text, connected = false) {
    const status = $('status');
    status.textContent = (connected ? '● ' : '○ ') + text;
    status.className = 'status' + (connected ? ' connected' : '');
}

function setConnectedUI(connected) {
    isConnected = connected;
    $('btnConnect').style.display = connected ? 'none' : 'block';
    $('quickCommands').style.display = connected ? 'block' : 'none';
    $('terminalContainer').style.display = connected ? 'block' : 'none';
    $('inputRow').style.display = connected ? 'block' : 'none';
    $('secondaryButtons').style.display = connected ? 'flex' : 'none';

    if (connected) {
        setTimeout(() => fitAddon && fitAddon.fit(), 50);
        $('cmdInput').focus();
    }
}

function vidPidHex(vid, pid) {
    const v = vid ? '0x' + vid.toString(16).padStart(4, '0') : '?';
    const p = pid ? '0x' + pid.toString(16).padStart(4, '0') : '?';
    return { vidHex: v, pidHex: p };
}

// ─── Conexión modo NATIVO (Web Serial API) ──────────────────────────
async function connectNative() {
    port = await navigator.serial.requestPort({ filters: NATIVE_FILTERS });
    await port.open({
        baudRate: BAUD_RATE,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
    });
    reader = port.readable.getReader();
    writer = port.writable.getWriter();

    const info = port.getInfo();
    return vidPidHex(info.usbVendorId, info.usbProductId);
}

// ─── Conexión modo WEBUSB DIRECTO ───────────────────────────────────
async function connectWebUSB() {
    usbDevice = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
    await usbDevice.open();

    if (usbDevice.configuration === null) {
        await usbDevice.selectConfiguration(1);
    }

    // Buscar interface CDC Data (clase 0x0A) o cualquier interface
    // con endpoints bulk in/out (caso vendor-specific).
    const interfaces = usbDevice.configuration.interfaces;
    let dataIface = null;
    let commIface = null;

    for (const iface of interfaces) {
        const alt = iface.alternates[0];
        if (alt.interfaceClass === CDC_DATA_CLASS) {
            dataIface = iface;
        } else if (alt.interfaceClass === CDC_COMM_CLASS) {
            commIface = iface;
        }
    }

    // Fallback: buscar interface con endpoints bulk in/out (vendor-specific)
    if (!dataIface) {
        for (const iface of interfaces) {
            const alt = iface.alternates[0];
            const hasBulkIn  = alt.endpoints.some(e => e.direction === 'in'  && e.type === 'bulk');
            const hasBulkOut = alt.endpoints.some(e => e.direction === 'out' && e.type === 'bulk');
            if (hasBulkIn && hasBulkOut) {
                dataIface = iface;
                break;
            }
        }
    }

    if (!dataIface) {
        throw new Error('No se encontró interface CDC Data ni alternativa con endpoints bulk');
    }

    usbInterface = dataIface.interfaceNumber;
    usbCommInterface = commIface ? commIface.interfaceNumber : 0;

    await usbDevice.claimInterface(usbInterface);

    const alt = dataIface.alternates[0];
    const epIn  = alt.endpoints.find(e => e.direction === 'in'  && e.type === 'bulk');
    const epOut = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
    if (!epIn || !epOut) {
        throw new Error('Interface CDC Data sin endpoints bulk in/out');
    }
    usbEpIn = epIn.endpointNumber;
    usbEpOut = epOut.endpointNumber;

    // CDC SET_CONTROL_LINE_STATE: DTR=1 RTS=1 (puerto activo).
    // El chip USB-Serial-JTAG del C3 puede ignorar esto, pero para
    // CP210x/CH340/FTDI sí es necesario para que el chip responda.
    try {
        await usbDevice.controlTransferOut({
            requestType: 'class',
            recipient: 'interface',
            request: 0x22,         // SET_CONTROL_LINE_STATE
            value: 0x03,           // DTR=bit0=1, RTS=bit1=1
            index: usbCommInterface,
        });
    } catch (e) {
        // No fatal — algunos firmwares (incluso del C3) no soportan este request
        console.warn('SET_CONTROL_LINE_STATE falló (no fatal):', e);
    }

    return vidPidHex(usbDevice.vendorId, usbDevice.productId);
}

// ─── Conexión global ────────────────────────────────────────────────
async function connectSerial() {
    if (!checkCompatibility()) return;

    try {
        let vidpid;
        if (hasNativeSerial) {
            mode = 'native';
            termWriteSystem('Modo: Web Serial nativo');
            vidpid = await connectNative();
        } else {
            mode = 'webusb';
            termWriteSystem('Modo: WebUSB directo (sin polyfill)');
            vidpid = await connectWebUSB();
        }

        $('portInfo').textContent = `VID=${vidpid.vidHex} PID=${vidpid.pidHex} · ${BAUD_RATE} baud`;

        updateStatus('Conectado al ESP32-C3', true);
        setConnectedUI(true);

        termWriteSystem('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        termWriteSystem(`✓ Puerto abierto · VID=${vidpid.vidHex} PID=${vidpid.pidHex}`);
        if (mode === 'webusb') {
            termWriteSystem(`  Interface=${usbInterface} · EP IN=0x${usbEpIn.toString(16)} OUT=0x${usbEpOut.toString(16)}`);
        }
        termWriteSystem('Tip: dale a VERSION? para empezar');
        termWriteSystem('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        startReadLoop();

    } catch (err) {
        if (err.name === 'NotFoundError') return;
        console.error(err);
        updateStatus('Error: ' + err.message, false);
        const banner = $('compatBanner');
        banner.style.display = 'block';
        banner.className = 'warning-box error';
        banner.textContent = '❌ ' + err.message +
            ' — Verifica que el APK haya liberado el driver cdc_acm primero.';
    }
}

// ─── Read loop UNIFICADO (despacha por mode) ────────────────────────
async function startReadLoop() {
    readLoopAbort = new AbortController();
    if (mode === 'native') {
        readLoopNative();
    } else {
        readLoopWebUSB();
    }
}

async function readLoopNative() {
    const decoder = new TextDecoder();
    let lineBuffer = '';
    try {
        while (!readLoopAbort.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) {
                termWriteSystem('⚠ Stream cerrado');
                break;
            }
            if (!value) continue;
            const text = decoder.decode(value, { stream: true });
            lineBuffer += text;
            let nlIdx;
            while ((nlIdx = lineBuffer.indexOf('\n')) !== -1) {
                const line = lineBuffer.slice(0, nlIdx).replace(/\r$/, '');
                lineBuffer = lineBuffer.slice(nlIdx + 1);
                if (line.length > 0) termWriteRecv(line);
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            const msg = (err && err.message) || String(err);
            termWriteSystem('⚠ Read loop nativo: ' + msg);
        }
    }
}

async function readLoopWebUSB() {
    const decoder = new TextDecoder();
    let lineBuffer = '';
    try {
        while (!readLoopAbort.signal.aborted) {
            let result;
            try {
                // 64 bytes es el packet size estándar para CDC bulk IN.
                // El USB-Serial-JTAG del C3 envía paquetes de 0 bytes
                // como keep-alive — los ignoramos (ESTO es lo que rompía
                // al polyfill).
                result = await usbDevice.transferIn(usbEpIn, 64);
            } catch (err) {
                if (err.name === 'NotFoundError'
                    || (err.message && err.message.includes('disconnect'))) {
                    termWriteSystem('⚠ USB desconectado');
                    break;
                }
                // stall u otro: intentar limpiar y seguir
                try { await usbDevice.clearHalt('in', usbEpIn); } catch (_) {}
                await new Promise(r => setTimeout(r, 50));
                continue;
            }

            if (result.status === 'stall') {
                try { await usbDevice.clearHalt('in', usbEpIn); } catch (_) {}
                continue;
            }
            if (result.status !== 'ok') continue;
            if (!result.data || result.data.byteLength === 0) continue;

            // result.data es DataView — convertir a Uint8Array para TextDecoder
            const chunk = new Uint8Array(result.data.buffer,
                                         result.data.byteOffset,
                                         result.data.byteLength);
            const text = decoder.decode(chunk, { stream: true });
            lineBuffer += text;

            let nlIdx;
            while ((nlIdx = lineBuffer.indexOf('\n')) !== -1) {
                const line = lineBuffer.slice(0, nlIdx).replace(/\r$/, '');
                lineBuffer = lineBuffer.slice(nlIdx + 1);
                if (line.length > 0) termWriteRecv(line);
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            const msg = (err && err.message) || String(err);
            termWriteSystem('⚠ Read loop WebUSB: ' + msg);
        }
    }
}

// ─── Send UNIFICADO ─────────────────────────────────────────────────
async function sendCommand(cmd) {
    if (!isConnected) {
        termWriteSystem('⚠ No conectado');
        return;
    }
    const trimmed = cmd.trim();
    if (!trimmed) return;

    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(trimmed + '\r\n');

        if (mode === 'native') {
            await writer.write(data);
        } else {
            await usbDevice.transferOut(usbEpOut, data);
        }

        termWriteSent(trimmed);

        if (cmdHistory[cmdHistory.length - 1] !== trimmed) {
            cmdHistory.push(trimmed);
            if (cmdHistory.length > 100) cmdHistory.shift();
        }
        historyIndex = cmdHistory.length;
    } catch (err) {
        const msg = (err && err.message) || String(err);
        console.error('Error sending:', err);
        termWriteSystem('⚠ Error al enviar: ' + msg);
    }
}

// ─── Disconnect ─────────────────────────────────────────────────────
async function disconnectSerial() {
    if (readLoopAbort) {
        readLoopAbort.abort();
        readLoopAbort = null;
    }

    if (mode === 'native') {
        if (reader) {
            try { await reader.cancel(); } catch (_) {}
            try { reader.releaseLock(); } catch (_) {}
            reader = null;
        }
        if (writer) {
            try { await writer.close(); } catch (_) {}
            try { writer.releaseLock(); } catch (_) {}
            writer = null;
        }
        if (port) {
            try { await port.close(); } catch (_) {}
            port = null;
        }
    } else if (mode === 'webusb' && usbDevice) {
        try {
            // SET_CONTROL_LINE_STATE a 0 — DTR=0 RTS=0
            await usbDevice.controlTransferOut({
                requestType: 'class',
                recipient: 'interface',
                request: 0x22,
                value: 0x00,
                index: usbCommInterface,
            });
        } catch (_) {}
        try { await usbDevice.releaseInterface(usbInterface); } catch (_) {}
        try { await usbDevice.close(); } catch (_) {}
        usbDevice = null;
        usbInterface = null;
        usbCommInterface = null;
        usbEpIn = null;
        usbEpOut = null;
    }

    mode = null;
    updateStatus('Desconectado', false);
    setConnectedUI(false);
    termWriteSystem('━━━ Desconectado ━━━');
}

// ─── Confirmaciones ─────────────────────────────────────────────────
function confirmAndSend(cmd, message) {
    if (confirm(message)) sendCommand(cmd);
}

// ─── Modal WIFI ─────────────────────────────────────────────────────
function openWifiModal() {
    $('wifiModal').style.display = 'flex';
    $('wifiSsid').value = '';
    $('wifiPass').value = '';
    updateWifiPreview();
    $('wifiSsid').focus();
}

function closeWifiModal() { $('wifiModal').style.display = 'none'; }

function updateWifiPreview() {
    const ssid = $('wifiSsid').value;
    const pass = $('wifiPass').value;
    $('wifiCmdPreview').textContent = `WIFI,${ssid},${pass}`;
}

function sendWifi() {
    const ssid = $('wifiSsid').value.trim();
    const pass = $('wifiPass').value;
    if (!ssid) {
        alert('SSID no puede estar vacío');
        return;
    }
    sendCommand(`WIFI,${ssid},${pass}`);
    closeWifiModal();
}

// ─── Inicialización ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    initTerminal();
    checkCompatibility();

    $('btnConnect').addEventListener('click', connectSerial);
    $('btnDisconnect').addEventListener('click', disconnectSerial);

    document.querySelectorAll('[data-cmd]').forEach(btn => {
        btn.addEventListener('click', () => sendCommand(btn.dataset.cmd));
    });

    $('btnReset').addEventListener('click', () =>
        confirmAndSend('RESET', '¿Reiniciar el ESP32-C3? Va a desconectar el USB unos segundos.'));
    $('btnUsbReset').addEventListener('click', () =>
        confirmAndSend('USB_RESET', '¿Forzar reenumeración USB (3s)? El puerto se desconectará y reconectará.'));
    $('btnRestartsClear').addEventListener('click', () =>
        confirmAndSend('RESTARTS_CLEAR', '¿Limpiar el contador de reinicios? Esta acción no se puede deshacer.'));
    $('btnWifiClear').addEventListener('click', () =>
        confirmAndSend('WIFI_CLEAR', '¿Borrar la configuración WiFi guardada? El ESP32 perderá la conexión hasta que reconfigures.'));

    $('btnWifiSet').addEventListener('click', openWifiModal);
    $('wifiCancel').addEventListener('click', closeWifiModal);
    $('wifiSend').addEventListener('click', sendWifi);
    $('wifiSsid').addEventListener('input', updateWifiPreview);
    $('wifiPass').addEventListener('input', updateWifiPreview);
    $('wifiModal').addEventListener('click', (e) => {
        if (e.target.id === 'wifiModal') closeWifiModal();
    });

    const cmdInput = $('cmdInput');
    cmdInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const val = cmdInput.value;
            cmdInput.value = '';
            sendCommand(val);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (historyIndex > 0) {
                historyIndex--;
                cmdInput.value = cmdHistory[historyIndex];
            }
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (historyIndex < cmdHistory.length - 1) {
                historyIndex++;
                cmdInput.value = cmdHistory[historyIndex];
            } else {
                historyIndex = cmdHistory.length;
                cmdInput.value = '';
            }
        }
    });
    $('btnSendCmd').addEventListener('click', () => {
        const val = cmdInput.value;
        cmdInput.value = '';
        sendCommand(val);
    });

    $('btnCopyLog').addEventListener('click', async () => {
        if (!term) return;
        const buf = term.buffer.active;
        const lines = [];
        for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line) lines.push(line.translateToString(true));
        }
        try {
            await navigator.clipboard.writeText(lines.join('\n'));
            termWriteSystem('✓ Log copiado al portapapeles');
        } catch (err) {
            termWriteSystem('⚠ No se pudo copiar: ' + err.message);
        }
    });

    $('btnClearLog').addEventListener('click', () => {
        if (term) term.clear();
    });

    if (hasNativeSerial) {
        navigator.serial.addEventListener('disconnect', () => {
            if (isConnected && mode === 'native') {
                termWriteSystem('⚠ Puerto desconectado físicamente');
                disconnectSerial();
            }
        });
    }
    if (hasWebUSB) {
        navigator.usb.addEventListener('disconnect', () => {
            if (isConnected && mode === 'webusb') {
                termWriteSystem('⚠ USB desconectado físicamente');
                disconnectSerial();
            }
        });
    }
});
