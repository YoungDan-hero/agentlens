/**
 * Minimal SFC shim so plain `tsc --noEmit` can check `main.ts`. Full
 * template-aware type checking would require vue-tsc, which is overkill
 * for a demo app.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent;
  export default component;
}
