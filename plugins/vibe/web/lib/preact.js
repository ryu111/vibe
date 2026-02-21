// Preact CDN re-export hub — 唯一 CDN 入口點
// 所有組件從這裡 import，不直接存取 CDN URL
import { h, render } from 'https://esm.sh/preact@10.25.4';
import { useState, useEffect, useRef, useMemo } from 'https://esm.sh/preact@10.25.4/hooks';
import htm from 'https://esm.sh/htm@3.1.1';

const html = htm.bind(h);

export { h, html, render, useState, useEffect, useRef, useMemo };
