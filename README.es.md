🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>La capa de memoria local para Claude Code y los coding agents compatibles con MCP.</strong><br />
    Un archivo SQLite. Sin Docker. Sin depender de la nube.
  </p>
</p>

> Este README en español es una guía resumida. Para la documentación completa y más reciente, toma como referencia el [English README](README.md).

## ¿Qué problema resuelve?

Los coding agents pierden el contexto con facilidad entre sesiones. Decisiones de arquitectura, bugs ya corregidos, lecciones aprendidas y restricciones del proyecto terminan explicándose una y otra vez.

**MeMesh conserva ese conocimiento en local, lo hace consultable y permite reutilizarlo cuando vuelve a hacer falta.**

Este paquete npm es la versión local del plugin / package de MeMesh. No es el producto de workspace en la nube ni una plataforma enterprise completa.

## Empieza en 60 segundos

### 1. Instala

```bash
npm install -g @pcircle/memesh
```

### 2. Guarda una decisión

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3. Recupérala después

```bash
memesh recall "login security"
# → encuentra "OAuth 2.0 with PKCE" aunque uses otras palabras
```

Abre el dashboard:

```bash
memesh
```

## ¿Para quién está pensado?

- Desarrolladores que usan Claude Code y quieren mantener contexto entre sesiones
- Usuarios avanzados que quieren compartir la misma memoria local entre varios MCP coding agents
- Equipos AI-native pequeños que quieren compartir conocimiento de proyecto vía export / import
- Desarrolladores de agents que quieren integrar memoria local mediante CLI, HTTP o MCP

## ¿Por qué MeMesh?

- Local-first: los datos quedan en tu propio archivo SQLite
- Instalación ligera: `npm install -g` y listo
- Integración directa: soporta CLI, HTTP y MCP
- Encaja bien con Claude Code: los hooks ayudan a traer el contexto adecuado al flujo de trabajo
- Es visible y manejable: el dashboard permite revisar y limpiar la memoria
- Límite de confianza más seguro: la memoria importada sigue siendo searchable, pero no se inyecta automáticamente en los hooks de Claude hasta que la revises o la vuelvas a guardar en local

## ¿Qué hace automáticamente en Claude Code?

Hoy MeMesh ayuda en 5 momentos:

- al iniciar la sesión, carga memorias relevantes y lecciones ya conocidas
- antes de editar archivos, recupera memoria relacionada con el archivo o el proyecto
- después de `git commit`, registra los cambios realizados
- al terminar la sesión, resume correcciones, errores y lessons learned
- antes del compactado de contexto, guarda lo importante en la memoria local

## ¿Qué incluye el dashboard?

El dashboard tiene 7 pestañas y soporte para 11 idiomas:

- Search: buscar memoria
- Browse: ver todas las memorias
- Analytics: revisar salud y tendencias
- Graph: ver relaciones de conocimiento
- Lessons: revisar lecciones aprendidas
- Manage: archivar y restaurar
- Settings: configurar proveedor de LLM e idioma

## ¿Qué es Smart Mode?

MeMesh funciona offline por defecto. Si configuras una API key de LLM, puedes activar capacidades adicionales, por ejemplo:

- query expansion
- mejor extracción automática
- organización y compresión más inteligentes

Sin API key, las funciones principales siguen disponibles.

## Más información

- Funciones completas, comparativas, API y detalles de release: [English README](README.md)
- Guía de integraciones: [docs/platforms/README.md](docs/platforms/README.md)
- Referencia de API: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)

## Desarrollo y verificación

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test
```
