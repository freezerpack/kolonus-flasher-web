// Kolonus ESP32-C3 Flasher (Web Edition v2.0.0)
// https://github.com/freezerpack/kolonus-flasher-web
//
// Diferencias clave vs el oficial de esptool-js:
//  - Dropdown de firmwares pre-cargados con offset embebido (poka-yoke):
//    Marco selecciona "Kolonus QR Reader v1.3.8" y NO escribe ningún offset.
//  - "🚨 Modo recuperación" para ESP32 brickeados (boot loop por bootloader corrupto).
//  - Baudrate forzado a 115200 (cambiar a 921600 falla con USB-CDC nativo del C3).
//  - Modo avanzado oculto detrás de un toggle para los casos custom.

import { SerialPort as WebSerialPolyfill }
    from 'https://unpkg.com/web-serial-polyfill@1.0.15/dist/serial.js';
import { ESPLoader, Transport }
    from 'https://unpkg.com/esptool-js@0.5.4/bundle.js';

// ─── Config ─────────────────────────────────────────────────────────
const BAUD_RATE = 115200;  // FIJO. NO cambiar — 921600 falla con USB-CDC nativo del C3.
const FIRMWARES_JSON = 'firmwares.json';

// VID conocidos para ESP32-C3 y variantes
const USB_FILTERS = [
    { vendorId: 0x303a },  // Espressif (ESP32-C3 USB-JTAG nativo)
    { vendorId: 0x10c4 },  // CP210x (Silicon Labs)
    { vendorId: 0x1a86 },  // CH340 (WCH)
    { vendorId: 0x0403 },  // FTDI
];

// ─── Estado ─────────────────────────────────────────────────────────
let port = null;
let transport = null;
let esploader = null;
let chip = null;
let firmwareData = null;       // string binario
let firmwareName = null;
let firmwareOffset = null;
let firmwareIsRecovery = false;
let isConnected = false;

let firmwareCatalog = [];      // [{id, name, file, offset, type, ...}]

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

const espLoaderTerminal = {
    clean()         { consoleEl.innerHTML = ''; },
    writeLine(data) { log(data, 'info'); },
    write(data)     { log(data, 'info'); },
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

function formatHex(num) {
    return '0x' + num.toString(16).toUpperCase().padStart(5, '0');
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ─── Compatibilidad ─────────────────────────────────────────────────
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

// ─── Carga del catálogo de firmwares ────────────────────────────────
async function loadFirmwareCatalog() {
    log('Cargando catálogo de firmwares...');
    try {
        const response = await fetch(FIRMWARES_JSON, { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        firmwareCatalog = data.firmwares || [];
        log(`✓ Catálogo cargado: ${firmwareCatalog.length} firmware(s)`, 'success');
        if (data.lastUpdated) {
            log(`  Última actualización: ${data.lastUpdated}`, 'debug');
        }
        populateFirmwareDropdown();
    } catch (e) {
        log('Error cargando firmwares.json: ' + e.message, 'error');
        log('Solo modo avanzado disponible (archivo .bin custom).', 'warning');
        $('firmwareSelect').innerHTML = '<option value="">— Sin catálogo (usa Modo avanzado) —</option>';
    }
}

function populateFirmwareDropdown() {
    const select = $('firmwareSelect');
    select.innerHTML = '<option value="">— Selecciona un firmware —</option>';

    let defaultId = null;
    for (const fw of firmwareCatalog) {
        const opt = document.createElement('option');
        opt.value = fw.id;
        opt.textContent = fw.name;
        select.appendChild(opt);
        if (fw.default && !defaultId) defaultId = fw.id;
    }

    if (defaultId) {
        select.value = defaultId;
        onFirmwareSelectionChanged();
    }
}

async function onFirmwareSelectionChanged() {
    const select = $('firmwareSelect');
    const fwId = select.value;
    const desc = $('firmwareDescription');
    const meta = $('firmwareMeta');

    if (!fwId) {
        desc.textContent = '';
        meta.innerHTML = '';
        firmwareData = null;
        firmwareName = null;
        firmwareOffset = null;
        firmwareIsRecovery = false;
        updateFlashButton();
        return;
    }

    const fw = firmwareCatalog.find(f => f.id === fwId);
    if (!fw) return;

    desc.textContent = fw.description || '';
    meta.innerHTML =
        `<span class="meta-item"><strong>Offset:</strong> ${fw.offsetHex}</span>` +
        `<span class="meta-item"><strong>Tamaño:</strong> ${formatSize(fw.sizeBytes)}</span>` +
        `<span class="meta-item"><strong>Tipo:</strong> ${fw.type}</span>`;

    firmwareIsRecovery = (fw.type === 'recovery');
    firmwareOffset = fw.offset;
    firmwareName = fw.name;

    // Descargar el .bin del repo
    log(`Descargando ${fw.file}...`, 'info');
    try {
        const response = await fetch(fw.file, { cache: 'force-cache' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // esptool-js espera string binario
        let binaryString = '';
        const chunkSize = 0x8000;  // procesar en chunks para evitar stack overflow
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binaryString += String.fromCharCode.apply(
                null, bytes.subarray(i, i + chunkSize)
            );
        }
        firmwareData = binaryString;

        log(`✓ Firmware cargado: ${fw.name}`, 'success');
        log(`  ${formatSize(bytes.length)} → offset ${fw.offsetHex}`, 'debug');
        if (firmwareIsRecovery) {
            log('━━━━━━ MODO RECUPERACIÓN ━━━━━━', 'warning');
            log('Este modo flashea el merge completo en 0x00000.', 'warning');
            log('Si el ESP32 está en boot loop, esptool-js intentará', 'warning');
            log('atrapar el chip entre resets. Puede tardar varios intentos.', 'warning');
            log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'warning');
        }
        updateFlashButton();
    } catch (e) {
        log('Error descargando firmware: ' + e.message, 'error');
        firmwareData = null;
        updateFlashButton();
    }
}

// ─── Modo avanzado: archivo custom ──────────────────────────────────
function handleCustomFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.bin')) {
        log('Error: solo archivos .bin', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        firmwareData = e.target.result;
        firmwareName = file.name + ' (custom)';
        firmwareOffset = parseInt($('customOffsetSelect').value, 10);
        firmwareIsRecovery = false;

        $('fileInfo').style.display = 'flex';
        $('fileName').textContent = file.name;
        $('fileSize').textContent = formatSize(firmwareData.length);
        $('customOffsetRow').style.display = 'block';

        // Resetear el select del catálogo (ya no se usa)
        $('firmwareSelect').value = '';
        $('firmwareDescription').textContent =
            'Modo avanzado activo: usando archivo custom seleccionado.';
        $('firmwareMeta').innerHTML = '';

        log(`✓ Archivo custom: ${file.name} (${formatSize(firmwareData.length)})`, 'success');
        log(`  Offset seleccionado: ${formatHex(firmwareOffset)}`, 'warning');
        updateFlashButton();
    };
    reader.readAsBinaryString(file);
}

function onCustomOffsetChanged() {
    if (firmwareData && firmwareName && firmwareName.includes('(custom)')) {
        firmwareOffset = parseInt($('customOffsetSelect').value, 10);
        log(`Offset custom actualizado: ${formatHex(firmwareOffset)}`, 'info');
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

        log(`Abriendo puerto a ${BAUD_RATE} baud (FIJO)...`);
        await port.open({ baudRate: BAUD_RATE });
        log('✓ Puerto abierto', 'success');

        log('Conectando al ESP32...');
        updateStatus('Sincronizando...', false);

        transport = new Transport(port, true);
        esploader = new ESPLoader({
            transport,
            baudrate: BAUD_RATE,
            romBaudrate: BAUD_RATE,  // Forzar mismo baud — evitar el switch que falla
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
        } else if (msg.includes('Unable to claim') || msg.includes('Access denied')) {
            log('━━━ DRIVER NO LIBERADO ━━━', 'warning');
            log('Vuelve al APK Kolonus Flash Launcher y pulsa FLASH', 'warning');
            log('para que libere el driver cdc_acm antes de conectar.', 'warning');
        }
    }
}

// ─── Flash ──────────────────────────────────────────────────────────
async function flash() {
    if (!isConnected || !firmwareData || firmwareOffset === null) {
        log('Falta conectar y/o seleccionar firmware', 'error');
        return;
    }

    const offsetHex = formatHex(firmwareOffset);

    try {
        $('btnFlash').disabled = true;
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');
        log('INICIANDO PROGRAMACIÓN', 'warning');
        log('Firmware: ' + firmwareName, 'info');
        log('Tamaño:   ' + formatSize(firmwareData.length), 'info');
        log('Offset:   ' + offsetHex, 'warning');
        if (firmwareIsRecovery) {
            log('Modo:     🚨 RECUPERACIÓN', 'warning');
        }
        log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'info');

        setProgress(0);

        await esploader.writeFlash({
            fileArray: [{ data: firmwareData, address: firmwareOffset }],
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
            }
        } catch (e) {
            log('Reset falló: ' + e.message, 'warning');
        }

        log('━━━ Vuelve al APK y pulsa "Restaurar lector QR" ━━━', 'info');

    } catch (error) {
        log('ERROR durante flasheo: ' + error.message, 'error');
        console.error('Flash error:', error);
    } finally {
        $('btnFlash').disabled = false;
    }
}

// ─── Diagnóstico USB ────────────────────────────────────────────────
async function runDiagnostic() {
    log('━━━━━━ DIAGNÓSTICO USB ━━━━━━', 'warning');

    if (!navigator.usb) {
        log('navigator.usb no existe — WebUSB no soportado', 'error');
        return;
    }
    log('✓ navigator.usb disponible', 'success');

    try {
        const devices = await navigator.usb.getDevices();
        log(`Dispositivos previamente autorizados: ${devices.length}`, 'info');
        devices.forEach((d, i) => {
            log(`  [${i}] VID=0x${d.vendorId.toString(16)} PID=0x${d.productId.toString(16)} ${d.productName || ''}`, 'debug');
        });
    } catch (e) {
        log('Error listando devices: ' + e.message, 'error');
    }

    try {
        log('Pulsa Conectar y elige el ESP32 en el picker...', 'info');
        const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });

        log('━━━ Dispositivo seleccionado ━━━', 'success');
        log(`Manufacturer:  ${device.manufacturerName || '—'}`, 'debug');
        log(`Product:       ${device.productName || '—'}`, 'debug');
        log(`Serial:        ${device.serialNumber || '—'}`, 'debug');
        log(`VID:PID:       0x${device.vendorId.toString(16)}:0x${device.productId.toString(16)}`, 'debug');
        log(`USB version:   ${device.usbVersionMajor}.${device.usbVersionMinor}`, 'debug');

        log(`Configuraciones disponibles: ${device.configurations.length}`, 'info');
        device.configurations.forEach((cfg, ci) => {
            log(`  Config[${ci}] value=${cfg.configurationValue}`, 'debug');
            cfg.interfaces.forEach((iface) => {
                iface.alternates.forEach((alt, ai) => {
                    const cls = alt.interfaceClass;
                    const className =
                        cls === 0x02 ? 'CDC Communications' :
                        cls === 0x0a ? 'CDC Data' :
                        cls === 0xff ? 'Vendor-specific (JTAG?)' :
                        cls === 0x03 ? 'HID' :
                        `0x${cls.toString(16)}`;
                    log(`    Interface ${iface.interfaceNumber} alt=${ai}: class=${className} subclass=0x${alt.interfaceSubclass.toString(16)} endpoints=${alt.endpoints.length}`, 'debug');
                });
            });
        });

        log('Intentando abrir el dispositivo...', 'info');
        try {
            await device.open();
            log('✓ device.open() OK', 'success');

            try {
                if (device.configuration === null) {
                    await device.selectConfiguration(1);
                }
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

    } catch (e) {
        if (e.name === 'NotFoundError') {
            log('Cancelado por el usuario', 'warning');
        } else {
            log(`Error en diagnóstico: ${e.message}`, 'error');
        }
    }
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
    log('Kolonus ESP32-C3 Flasher v2.0.0', 'info');
    log('────────────────────────────────', 'info');

    if (!checkCompatibility()) return;
    log('✓ WebUSB disponible', 'success');
    log('✓ HTTPS context OK', 'success');
    log(`Baudrate fijo: ${BAUD_RATE}`, 'debug');
    log('', 'info');

    // Listeners
    $('btnConnect').addEventListener('click', connect);
    $('btnFile').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', handleCustomFile);
    $('customOffsetSelect').addEventListener('change', onCustomOffsetChanged);
    $('btnFlash').addEventListener('click', flash);
    $('btnCopyLog').addEventListener('click', copyLog);
    $('btnClearLog').addEventListener('click', clearLog);
    $('btnDiagnostic').addEventListener('click', runDiagnostic);
    $('firmwareSelect').addEventListener('change', onFirmwareSelectionChanged);

    loadFirmwareCatalog();

    log('Selecciona un firmware del catálogo o usa Modo avanzado.', 'info');
    log('Si el ESP32 está en boot loop, usa "🚨 RESCATAR ESP32 BRICKEADO".', 'warning');
}

init();
