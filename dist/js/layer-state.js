export const IMAGERY_LAYERS = Object.freeze(["viking", "off"]);
export const ELEVATION_LAYERS = Object.freeze(["mola", "hirise", "ctx"]);
export const CTX_PHASES = Object.freeze(["idle", "loading", "ready", "error"]);

export function createLayerState({ imagery = "viking", elevation = "mola" } = {}) {
  return { imagery, elevation, ctx: { phase: "idle", message: "", errorCode: null } };
}

export function selectLayer(state, kind, value) {
  const choices = kind === "imagery" ? IMAGERY_LAYERS : kind === "elevation" ? ELEVATION_LAYERS : null;
  if (!choices) throw new TypeError(`Unknown layer kind: ${kind}`);
  if (!choices.includes(value)) throw new RangeError(`Unsupported ${kind} layer: ${value}`);
  return { ...state, [kind]: value };
}

export function updateCtxLayerStatus(state, { phase, message = "", errorCode = null } = {}) {
  if (!CTX_PHASES.includes(phase)) throw new RangeError(`Unsupported CTX status: ${phase}`);
  return { ...state, ctx: { phase, message, errorCode } };
}

export function canRetryCtx(state) {
  return state.ctx.phase === "error" && Boolean(state.ctx.errorCode) && state.ctx.errorCode !== "cache-capacity";
}

export function usesAutomaticRouteElevation(source) {
  return source === "mola" || source === "hirise";
}
