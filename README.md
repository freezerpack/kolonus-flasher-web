# Kolonus ESP32-C3 Flasher (Web Edition v2.0.0)

Herramienta web para flashear firmware en microcontroladores **ESP32-C3** (USB-JTAG nativo, VID `0x303a`) desde Chrome/Edge usando **WebUSB** y `esptool-js`.

> 🌐 **App en vivo**: https://freezerpack.github.io/kolonus-flasher-web/

---

## Filosofía: poka-yoke

A diferencia del [esptool-js oficial](https://espressif.github.io/esptool-js/), este flasher está diseñado para **prevenir errores humanos** en el flujo de operadores Kolonus:

- **Dropdown de firmwares pre-cargados** con offset embebido — el usuario NO escribe ningún `0x10000` manual (causa principal de bricking).
- **🚨 Modo recuperación** explícito en el dropdown — para ESP32 brickeados (boot loop por bootloader corrupto).
- **Baudrate forzado a 115200** — el switch a 921600 falla con USB-CDC nativo del C3.
- **Modo avanzado oculto** detrás de un toggle — para casos custom (archivo .bin externo).

## Cómo se usa (operador típico)

1. Conecta el ESP32-C3 al dispositivo con Chrome/Edge.
2. Abre **https://freezerpack.github.io/kolonus-flasher-web/**.
3. **Selecciona el firmware en el dropdown** — el offset se asigna automáticamente.
4. Pulsa **🔌 Conectar ESP32**.
5. Pulsa **⚡ PROGRAMAR ESP32-C3**.
6. Cuando termine, el ESP32 se reinicia automáticamente.

> 📱 Desde un **Konector** (Android 7), abrir el APK [KolonusFlashLauncher](../KolonusFlashLauncher) primero para liberar el driver `cdc_acm`, luego este flasher abre automáticamente.

## Catálogo de firmwares

Los firmwares oficiales viven en `/firmwares/` y se listan en `firmwares.json`:

| Archivo | Tipo | Offset | Tamaño |
|---|---|---|---|
| `USB-CDC-ESP32-C3-v1.3.8.bin` | App | `0x10000` | 1.01 MB |
| `USB-CDC-ESP32-C3-v1.3.8-MERGE.bin` | Merge completo | `0x00000` | 4 MB |

### Cómo agregar un firmware nuevo

1. Sube el `.bin` a `firmwares/`
2. Agrega una entrada en `firmwares.json`:
   ```json
   {
     "id": "kolonus-app-v1.4.0",
     "name": "Kolonus QR Reader v1.4.0 — App",
     "description": "...",
     "file": "firmwares/USB-CDC-ESP32-C3-v1.4.0.bin",
     "offset": 65536,
     "offsetHex": "0x10000",
     "type": "app",
     "sizeBytes": 1234567
   }
   ```
3. `git push` → GitHub Pages se actualiza solo en ~1 min → todos los Konectores ven el nuevo firmware sin reinstalar nada.

## Estructura

```
kolonus-flasher-web/
├── index.html         # UI
├── style.css          # Estilos
├── app.js             # Lógica WebUSB + esptool-js + carga de catálogo
├── firmwares.json     # Catálogo de firmwares disponibles
├── firmwares/
│   ├── USB-CDC-ESP32-C3-v1.3.8.bin
│   └── USB-CDC-ESP32-C3-v1.3.8-MERGE.bin
├── .gitignore
└── README.md
```

Todo estático. Sin backend. Hosteado en **GitHub Pages** (gratis, HTTPS automático).

## Stack

- [`esptool-js`](https://github.com/espressif/esptool-js) v0.5.4 — port de esptool a JS
- [`web-serial-polyfill`](https://github.com/google/web-serial-polyfill) v1.0.15 — emula Web Serial sobre WebUSB
- HTML/CSS/JS vanilla — sin frameworks, sin npm

## Limitaciones conocidas

- **Solo Chrome y Edge** — Firefox/Safari no implementan WebUSB.
- **Baudrate 115200 fijo** — cambiar a 921600 falla con USB-CDC nativo del ESP32-C3.
- **En Android**, requiere haber liberado el driver `cdc_acm` primero (lo hace el APK KolonusFlashLauncher). En desktop (Linux/macOS/Windows/ChromeOS) funciona directo.

## Desarrollo local

```bash
python -m http.server 8000
# Abre http://localhost:8000
```

WebUSB requiere `localhost` o HTTPS — `python -m http.server` sobre localhost funciona.

## Deploy

Cualquier `git push` a `main` se publica automáticamente en GitHub Pages en ~1 minuto.

---

Proyecto interno de [Kolonus Access Control Systems](https://kolonus.com).
