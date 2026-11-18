// For editors only: the globals DSM's desktop provides to packaged UI scripts
// (templates/ui/bridge.js). DSM ships its own Ext JS 3 build, so they stay untyped.

declare const Ext: any;

declare namespace SYNO {
  const Core: any;
  const FileStation: any;
  const SDS: any;
  const ux: any;
  const webfm: any;
}

/** DSM session values such as "SynoToken", "lang", "is_admin" and "standalone". */
declare function _S(key: string): any;
