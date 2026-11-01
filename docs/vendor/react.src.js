// react.src.js — React 18.3.1 and react-dom/client, production builds, bundled and minified into react.js so the
// page loads them as one same-origin file instead of from esm.sh. The import map in index.html points both "react"
// and "react-dom/client" here (one file, so one copy of React); htm is bundled separately into htm.js:
//
//   npm i react@18.3.1 react-dom@18.3.1 htm@3.1.1 esbuild
//   npx esbuild react.src.js --bundle --minify --format=esm --define:process.env.NODE_ENV='"production"' --outfile=react.js
//   npx esbuild htm.src.js --bundle --minify --format=esm --outfile=htm.js
import React from "react";
export default React;
export const { Fragment, createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } = React;
export { createRoot } from "react-dom/client";
