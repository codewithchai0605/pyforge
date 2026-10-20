declare module '*.css' {
  // utils/build/plugins/css.ts turns this into an empty module at build
  // time — the import is for its side effect (emitting the processed CSS
  // asset), so there's nothing useful to type.
  const noExport: undefined;
  export default noExport;
}
