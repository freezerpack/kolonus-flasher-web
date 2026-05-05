// Kolonus ESP32-C3 Flasher (Web Edition)
// Basado en flash.html del APK KolonusFlasher v2.4.0
// https://github.com/freezerpack/kolonus-flasher-web

import { SerialPort as WebSerialPolyfill }
    from 'https://unpkg.com/web-serial-polyfill@1.0.15/dist/serial.js';
import { ESPLoader, Transport }
    from 'https://unpkg.com/esptool-js@0.5.4/bundle.js';

// ─── Config ─────────────────────────────────────────────────────────
const BAUD_RATE = 115200;
const STORAGE_KEY_OFFSET = 'kolonus_flash_offset';

// VID conocidos para ESP32-C3 y variantes
const USB_FILTERS = [
    { vendorId: 0x303a },  // Espressif (ESP32-C3 USB-JTAG nativo)
    { vendorId: 0x10c4 },  // CP210x (Silicon Labs)
    { vendorId: 0x1a86 },  // CH340 (WCH)
];

// ─── Estado ─────────────────────────────────────────────────────────
let port = null;
let transport = null;
let esploader = null;
let chip = null;
let firmwareData = null;
let firmwareName = null;
let isConnected = false;

// ─── DOM refs ───────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const consoleEl = $('console');

// ─── Logger ─────────────────────────────────────────────────────────
function log(message, type = 'info') {
    const line = document.createElement('div');
    line.className = 'line ' + type;
    line.textContent = message;
    consoleEl.appendChild(line);
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

// Terminal que recibe esptool-js
const espLoaderTerminal = {
    clean()              { consoleEl.innerHTML = ''; },
    writeLine(data)      { log(data, 'info'); },
    write(data)          { log(data, 'info'); },
};

// ─── UI helpers ─────────────────────────────────────────────────────
function updateStatus(text, connected = false) {
    const status = $('status');
    status.textContent = (connected ? '● ' : '○ ') + text;
    status.className = 'status' + (connected ? ' connected' : '');
}

function setProgress(percent) {
    $('progressContainer').style.display = 'block';
    const bar = $('progressBar');
    bar.style.width = percent + '%';
    bar.textContent = percent + '%';
}

function updateFlashButton() {
    $('btnFlash').disabled = !(isConnected && firmwareData);
}

function getSelectedOffset() {
    return parseInt($('offsetSelect').value, 16);
}

function formatHex(num) {
    return '0x' + num.toString(16).toUpperCase().padStart(5, '0');
}

// ─── Compatibilidad del browser ─────────────────────────────────────
function checkCompatibility() {
    const banner = $('compatBanner');
    if (!navigator.usb) {
        banner.style.display = 'block';
        banner.classList.add('error');
        banner.textContent = '❌ WebUSB NO disponible. Usa Chrome o Edge en HTTPS.';
        $('btnConnect').disabled = true;
        return false;
    }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
        banner.style.display = 'block';
        banner.classList.add('error');
        banner.textContent = '❌ WebUSB requiere HTTPS. Esta página debe servirse por HTTPS.';
        $('btnConnect').disabled = true;
        return false;
    }
    return true;
}

// ─── Diagnóstico USB ────────────────────────────────────────────────
// Muy útil para entender qué interfaces expone el dispositivo
// y por cuál intenta hablar el polyfill. Crítico para debugging.
async function runDiagnostic() {
    log('━━━━━━ DIAGNÓSTICO USB ━━━━━━', 'warning');

    if (!navigator.usb) {
        log('navigator.usb no existe — WebUSB no soportado', 'error');
        return;
    }
    log('✓ navigator.usb disponible', 'success');

    // Listar dispositivos previamente autorizados
    try {
        const devices = await navigator.usb.getDevices();
        log(`Dispositivos previamente autorizados: ${devices.length}`, 'info');
        devices.forEach((d, i) => {
            log(`  [${i}] VID=0x${d.vendorId.toString(16)} PID=0x${d.productId.toString(16)} ${d.productName || ''}`, 'debug');
        });
    } catch (e) {
        log('Error listando devices: ' + e.message, 'error');
    }

    // Pedir un dispositivo nuevo y volcar todo su descriptor
    try {
        log('Pulsa Conectar y elige el ESP32 en el picker...', 'info');
        const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });

        log('━━━ Dispositivo seleccionado ━━━', 'success');
        log(`Manufacturer:  ${device.manufacturerName || '—'}`, 'debug');
        log(`Product:       ${device.productName || '—'}`, 'debug');
        log(`Serial:        ${device.serialNumber || '—'}`, 'debug');
        log(`VID:PID:       0x${device.vendorId.toString(16)}:0x${device.productId.toString(16)}`, 'debug');
        log(`USB version:   ${device.usbVersionMajor}.${device.usbVersionMinor}`, 'debug');
        log(`Device class:  0x${device.deviceClass.toString(16)} subclass=0x${device.deviceSubclass.toString(16)} protocol=0x${device.deviceProtocol.toString(16)}`, 'debug');

        log(`Configuraciones disponibles: ${device.configurations.length}`, 'info');
        device.configurations.forEach((cfg, ci) => {
            log(`  Config[${ci}] value=${cfg.configurationValue}`, 'debug');
            cfg.interfaces.forEach((iface, ii) => {
                iface.alternates.forEach((alt, ai) => {
                    const cls = alt.interfaceClass;
                    const className =
                        cls === 0x02 ? 'CDC Communications' :
                        cls === 0x0a ? 'CDC Data' :
                        cls === 0xff ? 'Vendor-specific (JTAG?)' :
                        cls === 0x03 ? 'HID' :
                        `0x${cls.toString(16)}`;
                    log(`    Interface ${iface.interfaceNumber} alt=${ai}: class=${className} subclass=0x${alt.interfaceSubclass.toString(16)} protocol=0x${alt.interfaceProtocol.toString(16)} endpoints=${alt.endpoints.length}`, 'debug');
                });
            });
        });

        // Intentar abrir el dispositivo y reportar resultado
        log('Intentando abrir el dispositivo...', 'info');
        try {
            await device.open();
            log('✓ device.open() OK', 'success');

            try {
                if (device.configuration === null) {
                    log('Configuración no seleccionada, llamando selectConfiguration(1)...', 'info');
                    await device.selectConfiguration(1);
                }

                // Probar claim de cada interface por separado
                for (const iface of device.configuration.interfaces) {
                    const ifNum = iface.interfaceNumber;
                    try {
                        await device.claimInterface(ifNum);
                        log(`✓ claimInterface(${ifNum}) OK`, 'success');
                        try { await device.releaseInterface(ifNum); } catch(_) {}
                    } catch (e) {
                        log(`✗ claimInterface(${ifNum}) FAIL: ${e.message}`, 'error');
                    }
                }
            } finally {
                try { await device.close(); } catch(_) {}
            }
        } catch (e) {
            log(`✗ device.open() FAIL: ${e.message}`, 'error');
        }

        log('━━━━━━ FIN DIAGNÓSTICO ━━━━━━', 'warning');
        log('Comparte este log con el equipo para análisis.', 'info');

    } catch (e) {
        if (e.name === 'NotFoundError') {
            log('Cancelado por el usuario', 'warning');
        } else {
            log(`Error en diagnóstico: ${e.message}`, 'error');
        }
    }
}

// ─── Conexión al ESP32 ──────────────────────────────────────────────
async function connect() {
    try {
        log('Solicitando dispositivo USB...');
        updateStatus('Buscando ESP32...', false);

        const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });

        log(`Dispositivo: ${device.productName || 'ESP32'}`);
        log(`VID:PID: 0x${device.vendorId.toString(16)}:0x${device.productId.toString(16)}`);

        log('Creando puerto serial (polyfill WebUSB → Web Serial)...');
        port = new WebSerialPolyfill(device);

        log(`Abriendo puerto a ${BAUD_RATE} baud...`);
        await port.open({ baudRate: BAUD_RATE });
        log('✓ Puerto abierto', 'success');

        log('Conectando al ESP32...');
        updateStatus('Sincronizando...', false);

        transport = new Transport(port, true);
        esploader = new ESPLoader({
            transport,
            baudrate: BAUD_RATE,
            terminal: espLoaderTerminal,
            debugLogging: false,
        });

        chip = await esploader.main();
        isConnected = true;

        updateStatus('Conectado', true);
        $('chipInfo').textContent = 'Chip: ' + chip;
        $('btnConnect').textContent = '✓ Conectado';
        $('btnConnect').disabled = true;
        updateFlashButton();

        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'success');
        log('✓ CONEXIÓN EXITOSA', 'success');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'success');

    } catch (error) {
        log('Error: ' + error.message, 'error');
        console.error('Full error:', error);
        updateStatus('Error de conexión', false);

        const msg = error.message || '';
        if (msg.includes('No device selected') || error.name === 'NotFoundError') {
            log('Cancelado por el usuario', 'warning');
        } else if (msg.includes('Unable to claim') || msg.includes('claiming') || msg.includes('Access denied')) {
            log('━━━ HIPÓTESIS CONFIRMADA ━━━', 'warning');
            log('El driver del kernel ya tiene reclamada la interface.', 'warning');
            log('En Android sin root no se puede liberar.', 'warning');
            log('Próximo paso: usar transport WebUSB custom sobre interface 1 (vendor-specific).', 'warning');
            log('Pulsa "Diagnóstico USB" para ver qué interfaces están disponibles.', 'info');
        }
    }
}

// ─── Selección de archivo ───────────────────────────────────────────
function handleFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.bin')) {
        log('Error: solo archivos .bin', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        firmwareData = e.target.result;
        firmwareName = file.name;

        $('fileInfo').style.display = 'flex';
        $('fileName').textContent = file.name;
        $('fileSize').textContent =
            (firmwareData.length / 1024).toFixed(1) + ' KB (' + firmwareData.length + ' bytes)';

        log(`✓ Firmware: ${file.name} (${firmwareData.length} bytes)`, 'success');
        updateFlashButton();
    };
    reader.readAsBinaryString(file);
}

// ─── Flash ──────────────────────────────────────────────────────────
async function flash() {
    if (!isConnected || !firmwareData) {
        log('Conecta y selecciona archivo primero', 'error');
        return;
    }

    const offset = getSelectedOffset();
    const offsetHex = formatHex(offset);

    try {
        $('btnFlash').disabled = true;
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
        log('INICIANDO PROGRAMACIÓN', 'warning');
        log('Archivo: ' + firmwareName, 'info');
        log('Tamaño:  ' + firmwareData.length + ' bytes', 'info');
        log('Offset:  ' + offsetHex, 'warning');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');

        setProgress(0);

        await esploader.writeFlash({
            fileArray: [{ data: firmwareData, address: offset }],
            flashSize: 'keep',
            flashMode: 'keep',
            flashFreq: 'keep',
            eraseAll: false,
            compress: true,
            reportProgress: (fileIndex, written, total) => {
                setProgress(Math.round((written / total) * 100));
            },
        });

        setProgress(100);
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'success');
        log('✓✓✓ PROGRAMACIÓN EXITOSA ✓✓✓', 'success');
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'success');

        // Hard reset por RTS (ESP32-C3 con USB-JTAG nativo)
        log('Reset por RTS...', 'info');
        try {
            if (transport && typeof transport.setRTS === 'function') {
                await transport.setRTS(true);   // EN → LOW
                await new Promise(r => setTimeout(r, 200));
                await transport.setRTS(false);  // EN → HIGH
                log('Reset enviado vía RTS', 'success');
            } else if (typeof esploader.hardReset === 'function') {
                await esploader.hardReset();
                log('Reset vía esploader.hardReset()', 'success');
            } else {
                log('Reset automático no disponible — desconecta y reconecta el ESP32', 'warning');
            }
        } catch (e) {
            log('Reset falló: ' + e.message, 'warning');
        }

    } catch (error) {
        log('ERROR: ' + error.message, 'error');
        console.error('Flash error:', error);
    } finally {
        $('btnFlash').disabled = false;
    }
}

// ─── Persistencia del offset ────────────────────────────────────────
function loadOffsetPreference() {
    const saved = localStorage.getItem(STORAGE_KEY_OFFSET);
    if (saved) {
        const select = $('offsetSelect');
        const option = [...select.options].find(o => o.value === saved);
        if (option) select.value = saved;
    }
}

function saveOffsetPreference() {
    localStorage.setItem(STORAGE_KEY_OFFSET, $('offsetSelect').value);
}

// ─── Log helpers ────────────────────────────────────────────────────
function copyLog() {
    const text = consoleEl.innerText;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text)
            .then(() => log('━━━ Log copiado ━━━', 'success'))
            .catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); log('━━━ Log copiado ━━━', 'success'); }
    catch (_) { log('No se pudo copiar', 'error'); }
    finally { document.body.removeChild(ta); }
}

function clearLog() {
    consoleEl.innerHTML = '';
    log('Log limpiado', 'info');
}

// ─── Init ───────────────────────────────────────────────────────────
function init() {
    log('Kolonus ESP32-C3 Flasher (Web) v1.0.0', 'info');
    log('────────────────────────────────────', 'info');

    if (!checkCompatibility()) return;
    log('✓ WebUSB disponible', 'success');
    log('✓ HTTPS context OK', 'success');
    log('', 'info');

    loadOffsetPreference();

    $('btnConnect').addEventListener('click', connect);
    $('btnFile').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', handleFile);
    $('btnFlash').addEventListener('click', flash);
    $('btnCopyLog').addEventListener('click', copyLog);
    $('btnClearLog').addEventListener('click', clearLog);
    $('btnDiagnostic').addEventListener('click', runDiagnostic);
    $('offsetSelect').addEventListener('change', saveOffsetPreference);

    log('Pulsa "Conectar ESP32" para iniciar.', 'info');
    log('Si falla, pulsa "Diagnóstico USB" para volcar info de las interfaces.', 'info');
}

init();
