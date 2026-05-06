// Kolonus ESP32-C3 Console (Web Edition v1.0.0)
// https://github.com/freezerpack/kolonus-flasher-web
//
// Consola serial para hablar con el firmware del ESP32-C3 corriendo
// (NO download mode). Usa Web Serial API + xterm.js.
//
// Comandos del firmware v1.3.8: VERSION?, ID?, MAC?, STATS?, RESTARTS?,
// WIFI?, WIFI,ssid,password, WIFI_CLEAR, PING_STATUS?, PING_ENABLE,
// PING_DISABLE, USB_RESET, RESET, RESTARTS_CLEAR, UART_TEST, HELP.
//
// Pre-requisito: el APK launcher debe haber liberado el cdc_acm vía
// "📡 Consola" antes de abrir esta página. Si no, el chip aparece en el
// picker de Web Serial pero al hacer port.open() falla con "device busy".

// ─── Config ─────────────────────────────────────────────────────────
const BAUD_RATE = 115200;  // Fijo, igual que el firmware

// VID conocidos para ESP32-C3 (mismo array que el flasher)
const USB_FILTERS = [
    { usbVendorId: 0x303a },  // Espressif (ESP32-C3 USB-JTAG nativo)
    { usbVendorId: 0x10c4 },  // CP210x (Silicon Labs)
    { usbVendorId: 0x1a86 },  // CH340 (WCH)
    { usbVendorId: 0x0403 },  // FTDI
];

// ─── Estado ─────────────────────────────────────────────────────────
let port = null;
let reader = null;
let writer = null;
let readLoopAbort = null;       // AbortController para cortar el read loop
let isConnected = false;
let term = null;                 // xterm.js Terminal
let fitAddon = null;             // FitAddon
let cmdHistory = [];             // historial de comandos enviados
let historyIndex = -1;           // posición actual en historial (↑/↓)

// ─── DOM refs ───────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Compatibilidad ─────────────────────────────────────────────────
function checkCompatibility() {
    const banner = $('compatBanner');
    if (!('serial' in navigator)) {
        banner.style.display = 'block';
        banner.textContent = '❌ Tu navegador NO soporta Web Serial API. ' +
            'Usa Chrome, Edge u Opera (Chromium 89+) en escritorio o Android.';
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
        convertEol: true,        // \n → \r\n al imprimir
        cursorBlink: true,
        disableStdin: true,      // todo input va por #cmdInput, no por el terminal
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open($('terminal'));
    fitAddon.fit();

    // Re-fit cuando cambia el viewport
    window.addEventListener('resize', () => fitAddon.fit());

    // Banner inicial
    termWriteSystem('Kolonus Console v1.0 — Conecta al ESP32-C3 para empezar');
    termWriteSystem('Tecla ↑/↓ para navegar el historial · Enter para enviar');
}

/** Escribe una línea coloreada de "sistema" (gris). */
function termWriteSystem(text) {
    if (!term) return;
    term.writeln('\x1b[90m' + text + '\x1b[0m');
}

/** Escribe el comando que ENVIAMOS al chip (cyan, prefijo `> `). */
function termWriteSent(text) {
    if (!term) return;
    term.writeln('\x1b[36m> ' + text + '\x1b[0m');
}

/** Escribe lo que el chip RESPONDE (color según contenido). */
function termWriteRecv(text) {
    if (!term) return;
    if (text.startsWith('OK,')) {
        term.writeln('\x1b[32m' + text + '\x1b[0m');  // verde
    } else if (text.startsWith('ERR,')) {
        term.writeln('\x1b[31m' + text + '\x1b[0m');  // rojo
    } else {
        term.writeln(text);                            // default
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
        // Re-ajustar terminal ahora que es visible
        setTimeout(() => fitAddon && fitAddon.fit(), 50);
        $('cmdInput').focus();
    }
}

// ─── Conexión Web Serial ────────────────────────────────────────────
async function connectSerial() {
    if (!checkCompatibility()) return;

    try {
        // Pedir al usuario que seleccione el puerto
        port = await navigator.serial.requestPort({ filters: USB_FILTERS });

        await port.open({
            baudRate: BAUD_RATE,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            flowControl: 'none',
        });

        // Info del puerto seleccionado
        const info = port.getInfo();
        const vidHex = info.usbVendorId
            ? '0x' + info.usbVendorId.toString(16).padStart(4, '0')
            : '?';
        const pidHex = info.usbProductId
            ? '0x' + info.usbProductId.toString(16).padStart(4, '0')
            : '?';
        $('portInfo').textContent = `VID=${vidHex} PID=${pidHex} · ${BAUD_RATE} baud`;

        updateStatus('Conectado al ESP32-C3', true);
        setConnectedUI(true);

        termWriteSystem('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        termWriteSystem(`✓ Puerto abierto · VID=${vidHex} PID=${pidHex} · ${BAUD_RATE} baud 8N1`);
        termWriteSystem('Tip: dale a VERSION? para empezar');
        termWriteSystem('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        // Lanzar read loop en background
        startReadLoop();

    } catch (err) {
        if (err.name === 'NotFoundError') {
            // El usuario canceló el picker
            return;
        }
        console.error(err);
        updateStatus('Error: ' + err.message, false);
        const banner = $('compatBanner');
        banner.style.display = 'block';
        banner.className = 'warning-box error';
        banner.textContent = '❌ ' + err.message +
            ' — Verifica que el APK haya liberado el driver cdc_acm primero.';
    }
}

async function disconnectSerial() {
    try {
        if (readLoopAbort) {
            readLoopAbort.abort();
            readLoopAbort = null;
        }
        if (reader) {
            try { await reader.cancel(); } catch (_) {}
            try { reader.releaseLock(); } catch (_) {}
            reader = null;
        }
        if (writer) {
            try { writer.releaseLock(); } catch (_) {}
            writer = null;
        }
        if (port) {
            try { await port.close(); } catch (_) {}
            port = null;
        }
    } catch (err) {
        console.error('Error al desconectar:', err);
    }
    updateStatus('Desconectado', false);
    setConnectedUI(false);
    termWriteSystem('━━━ Desconectado ━━━');
}

/** Read loop: escucha bytes del puerto y los pinta línea por línea
 *  en el terminal. Acumula en `lineBuffer` hasta encontrar \n.        */
async function startReadLoop() {
    readLoopAbort = new AbortController();
    const decoder = new TextDecoder();
    let lineBuffer = '';

    try {
        reader = port.readable.getReader();
        while (!readLoopAbort.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;

            const text = decoder.decode(value, { stream: true });
            lineBuffer += text;

            // Procesar líneas completas
            let nlIdx;
            while ((nlIdx = lineBuffer.indexOf('\n')) !== -1) {
                const line = lineBuffer.slice(0, nlIdx).replace(/\r$/, '');
                lineBuffer = lineBuffer.slice(nlIdx + 1);
                if (line.length > 0) termWriteRecv(line);
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('Read loop error:', err);
            termWriteSystem('⚠ Read loop terminó: ' + err.message);
        }
    } finally {
        try { reader && reader.releaseLock(); } catch (_) {}
        reader = null;
    }
}

/** Envía un comando al ESP32 (agrega CRLF y registra en historial). */
async function sendCommand(cmd) {
    if (!isConnected || !port) {
        termWriteSystem('⚠ No conectado');
        return;
    }
    const trimmed = cmd.trim();
    if (!trimmed) return;

    try {
        writer = port.writable.getWriter();
        const encoder = new TextEncoder();
        await writer.write(encoder.encode(trimmed + '\r\n'));
        writer.releaseLock();
        writer = null;

        termWriteSent(trimmed);

        // Guardar en historial (sin duplicados consecutivos)
        if (cmdHistory[cmdHistory.length - 1] !== trimmed) {
            cmdHistory.push(trimmed);
            if (cmdHistory.length > 100) cmdHistory.shift();
        }
        historyIndex = cmdHistory.length;
    } catch (err) {
        console.error('Error sending:', err);
        termWriteSystem('⚠ Error al enviar: ' + err.message);
        try { writer && writer.releaseLock(); } catch (_) {}
        writer = null;
    }
}

// ─── Confirmaciones para acciones destructivas ──────────────────────
function confirmAndSend(cmd, message) {
    if (confirm(message)) {
        sendCommand(cmd);
    }
}

// ─── Modal WIFI ─────────────────────────────────────────────────────
function openWifiModal() {
    $('wifiModal').style.display = 'flex';
    $('wifiSsid').value = '';
    $('wifiPass').value = '';
    updateWifiPreview();
    $('wifiSsid').focus();
}

function closeWifiModal() {
    $('wifiModal').style.display = 'none';
}

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

    // Botón conectar/desconectar
    $('btnConnect').addEventListener('click', connectSerial);
    $('btnDisconnect').addEventListener('click', disconnectSerial);

    // Quick commands (todos los que tienen data-cmd)
    document.querySelectorAll('[data-cmd]').forEach(btn => {
        btn.addEventListener('click', () => sendCommand(btn.dataset.cmd));
    });

    // Quick commands con confirmación
    $('btnReset').addEventListener('click', () =>
        confirmAndSend('RESET', '¿Reiniciar el ESP32-C3? Va a desconectar el USB unos segundos.'));
    $('btnUsbReset').addEventListener('click', () =>
        confirmAndSend('USB_RESET', '¿Forzar reenumeración USB (3s)? El puerto se desconectará y reconectará.'));
    $('btnRestartsClear').addEventListener('click', () =>
        confirmAndSend('RESTARTS_CLEAR', '¿Limpiar el contador de reinicios? Esta acción no se puede deshacer.'));
    $('btnWifiClear').addEventListener('click', () =>
        confirmAndSend('WIFI_CLEAR', '¿Borrar la configuración WiFi guardada? El ESP32 perderá la conexión hasta que reconfigures.'));

    // WIFI configurar (modal)
    $('btnWifiSet').addEventListener('click', openWifiModal);
    $('wifiCancel').addEventListener('click', closeWifiModal);
    $('wifiSend').addEventListener('click', sendWifi);
    $('wifiSsid').addEventListener('input', updateWifiPreview);
    $('wifiPass').addEventListener('input', updateWifiPreview);
    $('wifiModal').addEventListener('click', (e) => {
        if (e.target.id === 'wifiModal') closeWifiModal();  // click fuera cierra
    });

    // Input libre + Enter
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

    // Botones secundarios
    $('btnCopyLog').addEventListener('click', async () => {
        if (!term) return;
        // Tomamos el buffer activo y construimos texto plano
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

    // Si el puerto se desconecta (USB unplug)
    if ('serial' in navigator) {
        navigator.serial.addEventListener('disconnect', (e) => {
            if (e.target === port) {
                termWriteSystem('⚠ Puerto desconectado físicamente');
                disconnectSerial();
            }
        });
    }
});
