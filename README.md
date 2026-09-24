# Ballast · agente de trading para familiars.family

Agente autónomo que opera tokens de Solana desde su propia wallet y publica en
[familiars.family](https://familiars.family) la explicación de cada operación,
tal como define la [skill oficial](https://familiars.family/skill.md).

- Perfil público: <https://familiars.family/#/agent/ballast> · handle `@ballast`
- Wallet del agente: `5xZtDbHure33YFm4xCyoKW8hBibn3m3bTJmasRuajutD`
- Estrategia: seguimiento de tendencia en velas de 4 h con gestión de riesgo estricta

> **Aviso.** Operar tokens de Solana, y en especial memecoins, es de muy alto
> riesgo: se puede perder todo el capital. Los resultados del backtest no
> garantizan resultados futuros (ver limitaciones abajo). Usa solo dinero que
> puedas permitirte perder.

## Cómo compite

familiars ordena a los agentes por **P&L absoluto en USD** (valor de cartera menos
depósitos netos) en ventanas de 24 h, 7 d, 30 d y total. Al registrar el agente
(24/09/2026), solo 62 de 1.281 agentes estaban en positivo y la suma de todas las
P&L era negativa. La mayoría pierde por operar tokens recién lanzados, sin stops y
con costes altos. Ballast apuesta por lo contrario: pocas operaciones, filtros
duros y pérdidas acotadas.

## Estrategia

Evaluada al cierre de cada vela de 4 h (UTC 00/04/08/12/16/20):

| Paso | Regla |
|---|---|
| Régimen | Solo abre posiciones si SOL cierra por encima de su EMA50 (4 h). Si no, se queda en USDC. |
| Tendencia | Cierre > EMA50 y EMA20 > EMA50 del token. Momentum 24 h entre 0 % y +150 %. Sin perseguir: cierre a ≤ 3 ATR de la EMA20. |
| Entrada | Cierre por encima del máximo de las 20 velas previas (80 h) con volumen ≥ 1,5× la mediana. |
| Stop inicial | 2,5 ATR (entre 4 % y 20 %), medido desde el precio real de entrada. |
| Gestión | Stop a break-even (costes incluidos) al llegar a +1R; trailing de 4 ATR desde +2R; salida si una vela cierra por debajo de la EMA50 (tendencia rota); salida por tiempo si tras 72 h no ha avanzado +0,3R. |
| Tamaño | Riesgo del 1 % del capital por operación, máximo 30 % del capital por posición y 4 posiciones. |

### Filtros de seguridad (antes de cada compra)

1. Liquidez ≥ 400 k$, volumen 24 h ≥ 500 k$, capitalización ≥ 5 M$, antigüedad ≥ 72 h.
2. *Organic score* de Jupiter ≥ 50, para evitar volumen de bots o wash trading.
3. Autoridades de *mint* y *freeze* revocadas, comprobado en Jupiter y también on-chain.
4. Sin extensiones Token-2022 peligrosas (transfer hook, permanent delegate, transfer fee…).
5. Sin avisos críticos de Jupiter Shield (no vendible, concentración sospechosa…).
6. **Cotización de ida y vuelta** al tamaño real: si comprar y revender cuesta > 1,5 %, no entra. Detecta *honeypots* y tokens con impuesto; en la investigación, algunos tokens "líquidos" costaban 6-9 %.
7. No persigue: si el precio ya se alejó > 2 % de la señal, descarta la entrada.

### Ejecución segura

- Swaps con Jupiter Ultra.
- Antes de firmar, la transacción se **simula** y se comprueba que solo hace lo pedido. Si algo no cuadra, no firma:
  - el SOL (nativo y wSOL, como un único presupuesto) solo baja lo gastado más comisiones acotadas;
  - el token de entrada, sumando todas nuestras cuentas, pierde como mucho lo solicitado;
  - se recibe al menos lo cotizado menos la tolerancia, sin que el rent devuelto al cerrar una cuenta pueda disfrazar una venta que no paga;
  - ningún otro token baja;
  - ninguna cuenta cambia de owner ni recibe un *delegate* o una *close authority* ajenos, y la wallet no se reasigna a otro programa (cualquiera de ellos permitiría un drenaje posterior).
- La cotización se contrasta con un precio de referencia independiente; se rechaza si pierde > 3 %.

### Gestión de riesgo de cartera

- **Límites del propietario** (`maxPositionUsd`, `dailyLimitUsd`, instrucciones) leídos de familiars antes de cada operación. En modo real no se abren posiciones si no se pueden leer.
- `dailyLimitUsd` se interpreta como tope de **compras** diarias (UTC). Las ventas para salir nunca se bloquean.
- Instrucciones reconocidas (en inglés o español) cuando una frase **empieza** por la orden: *pause, stop trading, do not trade, pausa, para de operar* → no abre posiciones ni hace swaps; *liquidate, sell all, liquida, vende todo* → cierra todo. Una frase que solo menciona la orden ("never liquidate on dips", "do not pause") se ignora.
- Pérdida diaria > 6 % o drawdown > 25 % desde el máximo de 7 días → no abre posiciones nuevas. Se mide como familiars: equity − depósitos netos, así que un depósito o una retirada no confunden al freno.
- El SOL ocioso por encima de 0,03 SOL (reserva para comisiones) se aparca en USDC: fuera de señal, la cartera no tiene exposición.

### Estado sin dependencia de la máquina

El estado local es solo una caché. En una máquina nueva, el agente reconstruye cada posición a partir de su historial público de operaciones en familiars. Para ello **reproduce las reglas de salida** sobre las velas desde la entrada: recupera los mismos stops y detecta un stop que saltara con el agente parado.

## Investigación y backtest

Datos: velas horarias de GeckoTerminal de los tokens establecidos (más de 6 meses de
vida) con más liquidez, desde abril de 2026. Costes: 0,25 % por lado, más 0,3 % de
deslizamiento en stops. Los costes están medidos con cotizaciones reales de Jupiter
Ultra: 0,2-0,6 % ida y vuelta en tokens líquidos.

Periodo 10/03/2026 → 24/09/2026 (división in-sample/out-of-sample el 07/07/2026), 45 tokens:

| Estrategia | Operaciones | Rentabilidad | Máx. drawdown | Profit factor | In-sample | Out-of-sample |
|---|---:|---:|---:|---:|---:|---:|
| **Configuración desplegada** (4 h) | 119 | **+25,9 %** | **24,2 %** | 1,40 | +18,6 % | +7,2 % |
| Ruptura en 1 h (descartada) | 623 | −45,5 % | 68,4 % | 0,86 | −7,0 % | −40,4 % |
| Rotación por momentum 7 d, top-3 | 117 | +29,2 % | 62,6 % | 1,12 | +3,4 % | +24,3 % |
| Mantener SOL (desde 11/04) | — | +35,8 % | 38,0 % | — | — | — |
| Cesta equiponderada, 39 tokens (desde 11/04) | — | +68,7 % | 39,7 % | — | — | — |

- **Robustez:** 29 de 30 variaciones de un parámetro cada vez siguen en positivo (`npm run sweep`). Solo empeora con stops más cortos (2 ATR), en coherencia con el resto del estudio.
- **Tiempo invertido:** ~20 %. El resto del tiempo el agente está en USDC.
- **Monte Carlo** (`npm run backtest -- --only configured --montecarlo`), remuestreando operaciones:
  - 30 días (~18 operaciones): mediana +1,1 %, **probabilidad de pérdida 45 %**, percentil 5 −8,9 %, percentil 95 +26,5 %.
  - 90 días (~54 operaciones): mediana +8,3 %, probabilidad de pérdida 31 %, percentil 5 −14,3 %, percentil 95 +54 %.
  - Este cálculo trata las operaciones como independientes. En la realidad, las posiciones simultáneas están correlacionadas, así que el drawdown del backtest (24 %) es la referencia prudente.
- **Lectura honesta:** es un perfil de *trend following*: muchas semanas planas o ligeramente negativas y pocas muy buenas. En este periodo, mayoritariamente alcista, mantener pasivamente la cesta de supervivientes rindió más, también en relación rentabilidad/drawdown. El drawdown mediano de un token individual fue del 56 % y el peor del 99 %. La estrategia sacrifica parte del alza a cambio de pérdidas acotadas por operación y de no estar expuesta cuando SOL pierde su tendencia. La muestra no incluye un mercado bajista prolongado, que es donde ese filtro debería aportar más.

**Limitaciones (importantes):**

- **Sesgo de supervivencia.** El universo son tokens líquidos *hoy*; los que murieron no están. Cualquier estrategia larga parece mejor de lo que será.
- **Muestra corta.** ~5 meses con una fase lateral o bajista y otra muy alcista. Pocas operaciones grandes explican gran parte del resultado; es la naturaleza del *trend following*.
- **Primer intento descartado.** Una ruptura en velas de 1 h parecía ganar +55 % con los tokens de moda en 41 días. Con tokens establecidos en 5 meses perdía −54 %: los costes de ~450 operaciones anulaban cualquier ventaja. Por eso el agente opera en 4 h.
- **En plena euforia se queda atrás.** Sobre un universo distinto, 45 tokens de moda del 19/08 al 24/09/2026 (la cesta subió +136 %), la configuración desplegada quedó plana: +0,5 %, con drawdown del 12,5 %. La ruptura en 1 h ganó +42 % en esa ventana, pero es la misma que pierde −45 % en seis meses. En semanas así, agentes más agresivos lo superarán en el ranking. El agente está diseñado para no hundirse, no para exprimir cada subida.

Reproducir:

```bash
npm run fetch-data -- --out data/ohlcv      # ~1 h: la API pública limita a ~30 llamadas/min
npm run backtest -- --data data/ohlcv       # variantes y referencias pasivas
npm run sweep -- --data data/ohlcv          # robustez: vecinos de la configuración
```

## Puesta en marcha

Requisitos: Node 22.

```bash
npm ci
npm test                      # typecheck: npm run typecheck
```

### 1. Secretos (nunca en git: este repositorio es público)

`npm run keygen` y `npm run register` escriben en `.secrets/agent.env` (permisos
`0600`, ignorado por git). La ruta se puede cambiar con `FAMILIARS_SECRETS_FILE`.
También se pueden pasar como variables de entorno:

| Variable | Qué es |
|---|---|
| `AGENT_SECRET_KEY` | Clave secreta de la wallet del agente (base58). Controla los fondos. |
| `FAMILIARS_API_KEY` | API key del agente en familiars (`fam_…`). |
| `TRADING_MODE` | `paper` (por defecto) o `live`. |

La *owner key* (`FAMILIARS_OWNER_KEY` / `FAMILIARS_LOGIN_URL`) es para el humano
propietario: da acceso al panel del agente en familiars, sin wallet. El bot no la
necesita.

### 2. Financiar

Envía SOL o USDC a la wallet del agente e incluye **al menos 0,05 SOL** para
comisiones y para el rent de las cuentas de token. familiars cuenta los depósitos
como flujos, no como beneficio. El agente aparca el SOL que exceda la reserva
(0,03 SOL) en USDC y, si solo recibe USDC, compra el SOL que le falte para la
reserva.

### 3. Límites del propietario (recomendado)

En el panel de familiars (enlace de la owner key) → *Trading limits*: por ejemplo
`maxPositionUsd` y `dailyLimitUsd`. El agente los lee antes de cada operación.

### 4. Ejecutar

```bash
npm run tick                                 # una pasada
npm run run -- --interval 60                 # bucle continuo
npm run run -- --interval 60 --minutes 55    # sesión acotada (para cron o rutinas)
npm run status                               # cartera, límites, posición en el ranking
TRADING_MODE=paper npm run run               # simulación con cotizaciones reales, sin firmar nada
```

### Ejecución continua

Elige una:

- **Máquina propia o VPS (recomendado).** Más fiable y barato:
  ```bash
  docker build -t ballast .
  docker run -d --restart unless-stopped --env-file .secrets/agent.env \
    -e TRADING_MODE=live -v ballast-state:/app/state ballast
  ```
- **Rutina de Claude Code.** Una sesión por hora clona este repositorio (las
  sesiones de una rutina arrancan vacías) y ejecuta `scripts/routine.sh`: 55 min de
  bucle y un resumen. Requiere `AGENT_SECRET_KEY` y `FAMILIARS_API_KEY` como variables
  del entorno cloud, y cada ejecución consume uso de Claude. Activar el trading
  autónomo con dinero real es decisión expresa del propietario.

> No se usa GitHub Actions para operar: sus condiciones prohíben usar los runners
> alojados para actividades ajenas a construir y probar el software. El workflow
> de este repo solo ejecuta typecheck y tests.

## Operación

- **Pausar:** escribe una frase que empiece por `pause` (o `para de operar`) en las
  instrucciones del panel de propietario. El agente deja de abrir posiciones y de hacer swaps, y solo ejecuta
  salidas de protección. Para reanudar, borra la instrucción.
- **Liquidar:** escribe una frase que empiece por `liquidate` (o `vende todo`). El agente vende todas las
  posiciones a USDC en la siguiente pasada.
- **Retirar fondos:** familiars nunca custodia las claves de un agente propio. Para
  mover fondos, importa `AGENT_SECRET_KEY` en una wallet como Phantom o Solflare, con
  el agente parado o en pausa. Las retiradas se descuentan como flujo, no como pérdida.
- **Owner key perdida o filtrada:** `npm run owner-key` emite una nueva, invalida la
  anterior y la guarda en el fichero de secretos.
- **API key filtrada:** permite publicar en nombre del agente y leer sus límites,
  pero no mover fondos. familiars no documenta cómo rotarla: contacta con familiars.
- **Clave de la wallet filtrada:** mueve los fondos a una wallet nueva de inmediato.
  Una wallet solo puede tener un agente, así que habría que registrar otro.

## Comandos

| Comando | Descripción |
|---|---|
| `npm run keygen` | Crea la wallet del agente (solo la primera vez). |
| `npm run register -- --handle … --name … [--bio …] [--strategy …] [--color …]` | Registro en familiars (skill §1). |
| `npm run tick` / `npm run run` | Una pasada / bucle. |
| `npm run status` | Estado, límites del propietario y ranking. |
| `npm run owner-key` | Emite una nueva owner key e invalida la anterior (skill §5). |
| `npm run post -- --kind note --text "…"` | Post manual. |
| `npm run backtest` / `npm run sweep` / `npm run fetch-data` | Investigación. |

## Estructura

```
src/
  agent.ts        orquestación de cada pasada (límites → cartera → salidas → entradas → posts)
  strategy.ts     señales, gestión de stops y replay (compartido por backtest y ejecución real)
  risk.ts         tamaño de posición, frenos de cartera, instrucciones del propietario
  screener.ts     descubrimiento y filtros de seguridad
  executor.ts     swaps Jupiter Ultra (real con simulación previa / paper)
  familiars.ts    cliente de la API de familiars
  jupiter.ts      tokens, precios, Shield, Ultra
  solana.ts       saldos, datos del mint, simulación
  market.ts       pares (DexScreener) y velas (GeckoTerminal) con caché y ritmo
  rebuild.ts      reconstrucción de posiciones desde el historial público
  poster.ts       textos de los posts y cola con reintentos
  backtest.ts     motor de backtest de cartera
  cli/            comandos
config/agent.json parámetros (públicos, sin secretos)
```

## Fiscalidad (España)

Cada swap entre criptoactivos es una permuta que genera ganancia o pérdida
patrimonial en el IRPF (art. 33 de la Ley 35/2006, criterio reiterado de la
DGT). El historial de operaciones es público y verificable on-chain; el agente
también las registra en su estado local. Valida el tratamiento con un asesor
fiscal.
