# Kolonus ESP32-C3 Flasher (Web Edition)

Herramienta web para flashear firmware en microcontroladores **ESP32-C3** (USB-JTAG nativo, VID `0x303a`) directamente desde Chrome/Edge usando **WebUSB** y `esptool-js` — sin instalar ningún APK ni programa.

> 🌐 **App en vivo**: https://freezerpack.github.io/kolonus-flasher-web/

---

## Para qué sirve

Este proyecto es la evolución web del APK [KolonusFlasher](../KolonusFlasher) que se usaba sobre Orange Pi 3 con Android 7. La idea es eliminar la necesidad de instalar un APK: solo abres una URL en Chrome y flasheas.

## Cómo se usa

1. Conecta el ESP32-C3 a un dispositivo con Chrome o Edge (Android 7+, Windows, macOS, Linux, ChromeOS).
2. Abre **https://freezerpack.github.io/kolonus-flasher-web/**.
3. Selecciona la dirección de flash:
   - **0x10000** — solo App firmware (default)
   - **0x00000** — imagen merge completa (bootloader + partition + app)
4. Pulsa **🔌 Conectar ESP32** y elige el dispositivo en el picker de Chrome.
5. Pulsa **📁 Seleccionar .bin** y elige el firmware.
6. Pulsa **⚡ PROGRAMAR ESP32-C3**.
7. Cuando termine, el ESP32 se reinicia automáticamente.

## Limitaciones conocidas (por confirmar)

- **No funciona en Firefox / Safari** — solo Chrome y Edge implementan WebUSB.
- **Web Serial API NO existe en Chrome Android** — esta herramienta usa WebUSB con polyfill (`web-serial-polyfill`).
- **En Android, si el kernel reclama el driver `cdc_acm`** sobre la interface 0 del ESP32-C3, puede fallar con `Unable to claim interface`. Si pasa, pulsa el botón **🔍 Diagnóstico USB** y comparte el log para análisis.

## Estructura

```
kolonus-flasher-web/
├── index.html      # UI
├── style.css       # Estilos
├── app.js          # Lógica WebUSB + esptool-js
├── .gitignore
└── README.md
```

Todo es estático — no requiere backend. Se hostea en **GitHub Pages** (gratis, HTTPS automático).

## Stack

- [`esptool-js`](https://github.com/espressif/esptool-js) v0.5.4 — port de esptool a JS
- [`web-serial-polyfill`](https://github.com/google/web-serial-polyfill) v1.0.15 — emula Web Serial sobre WebUSB
- HTML/CSS/JS vanilla — sin frameworks

Las dependencias se cargan vía `unpkg.com` como módulos ES6, no requieren `npm install`.

## Desarrollo local

WebUSB requiere HTTPS o `localhost`. Para probar local:

```bash
# Opción 1: Python
python -m http.server 8000
# Abre http://localhost:8000

# Opción 2: Node
npx serve .
```

## Deploy

Cualquier `git push` a `main` se publica automáticamente en GitHub Pages en ~1 minuto.

## Roadmap

- [ ] Iteración 1: probar empíricamente en Konector con ESP32-C3 (¿funciona sin unbind del kernel?)
- [ ] Iteración 2 (si Iter 1 falla): implementar transport WebUSB custom sobre interface 1 (vendor-specific)
- [ ] Iteración 3: agregar firmware embebido descargable desde el repo
- [ ] Iteración 4: indicador de versión del firmware embebido vs el flasheado

---

Proyecto interno de [Kolonus Access Control Systems](https://kolonus.com).
