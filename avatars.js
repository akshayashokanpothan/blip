// Blip avatars: ten small flat illustrations people can pick for their profile.
// Each is drawn as an SVG string so there are no image files to load.
(function (root) {
  const face = (skin, o = {}) => `
    <path d="M18 100 C18 76 32 67 48 67 C64 67 78 76 78 100 Z" fill="${o.shirt}"/>
    <rect x="42" y="54" width="12" height="14" rx="5" fill="${skin}"/>
    <circle cx="48" cy="42" r="18" fill="${skin}"/>
    <circle cx="41.5" cy="43" r="2.1" fill="#1B241F"/>
    <circle cx="54.5" cy="43" r="2.1" fill="#1B241F"/>
    <circle cx="38" cy="49" r="2.6" fill="#F28B82" opacity=".35"/>
    <circle cx="58" cy="49" r="2.6" fill="#F28B82" opacity=".35"/>
    <path d="M43.5 50.5 Q48 54.5 52.5 50.5" fill="none" stroke="#1B241F" stroke-width="2" stroke-linecap="round"/>`;
  const glasses = (c = '#1B241F') => `
    <circle cx="41.5" cy="43" r="5" fill="none" stroke="${c}" stroke-width="1.8"/>
    <circle cx="54.5" cy="43" r="5" fill="none" stroke="${c}" stroke-width="1.8"/>
    <path d="M46.5 43 H49.5" stroke="${c}" stroke-width="1.8"/>`;
  const shortHair = (c) => `<path d="M29.5 41 C29 26 38 21 48 21 C59 21 67 27 66.5 41 C64 34 58 30.5 49 30.5 C42 30.5 36 33 33 37 Z" fill="${c}"/>`;

  const AVATARS = {
    sunny: { label: 'Sunny', bg: '#FCE7B2', draw: () => {
      const s = '#F1C9A5', h = '#3B2A20';
      return `<path d="M26 66 C24 44 28 24 48 22 C68 24 72 44 70 66 Z" fill="${h}"/>${face(s, { shirt: '#2D5A42' })}
        <path d="M30 40 C31 27 40 22 48 22 C57 22 65 27 66 40 C60 33 52 30 44 31 C38 32 33 35 30 40 Z" fill="${h}"/>`; } },
    sam: { label: 'Sam', bg: '#CFE6DA', draw: () => {
      const s = '#C68B5E';
      return `${face(s, { shirt: '#1B3B2B' })}${shortHair('#20160F')}`; } },
    maya: { label: 'Maya', bg: '#F7D3CC', draw: () => {
      const s = '#8D5A3B', h = '#1B1210';
      return `${face(s, { shirt: '#D6A24B' })}${shortHair(h)}<circle cx="48" cy="19" r="8" fill="${h}"/>`; } },
    leo: { label: 'Leo', bg: '#D9E4F5', draw: () => {
      const s = '#E8B48F', h = '#7A4A23';
      return `${face(s, { shirt: '#4F6D8F' })}${shortHair(h)}${glasses()}`; } },
    noor: { label: 'Noor', bg: '#E8DDF4', draw: () => {
      const s = '#D9A47E', w = '#6E4A8E';
      return `<path d="M22 100 C20 70 26 58 30 44 C31 28 39 19 48 19 C57 19 65 28 66 44 C70 58 76 70 74 100 Z" fill="${w}"/>
        ${face(s, { shirt: w })}
        <path d="M29 44 C29 27 38 19 48 19 C58 19 67 27 67 44 C67 40 64 32 58 28 C54 26 51 25.5 48 25.5 C45 25.5 42 26 38 28 C32 32 29 40 29 44 Z" fill="${w}"/>
        <path d="M30 44 C30 58 38 63 48 63 C58 63 66 58 66 44 C66 56 60 66 48 66 C36 66 30 56 30 44 Z" fill="${w}"/>
        <rect x="36" y="59.5" width="24" height="14" fill="${w}"/>`; } },
    arjun: { label: 'Arjun', bg: '#D7EBC8', draw: () => {
      const s = '#B07A52', h = '#17110D';
      return `${face(s, { shirt: '#58B889' })}${shortHair(h)}
        <path d="M31 46 C32 58 39 62 48 62 C57 62 64 58 65 46 C62 52 58 55 54 53 C51 55.5 45 55.5 42 53 C38 55 34 52 31 46 Z" fill="${h}"/>
        <path d="M43.5 51 Q48 54 52.5 51" fill="none" stroke="#F3E3D6" stroke-width="1.6" stroke-linecap="round"/>`; } },
    zoe: { label: 'Zoe', bg: '#FDDDE6', draw: () => {
      const s = '#F3D2BC', h = '#C2562E';
      const curls = [[32,34],[36,26],[44,22],[52,22],[60,26],[64,34],[30,42],[66,42]].map(([x,y]) => `<circle cx="${x}" cy="${y}" r="7" fill="${h}"/>`).join('');
      return `${face(s, { shirt: '#1B3B2B' })}${curls}`; } },
    kai: { label: 'Kai', bg: '#C9ECEC', draw: () => {
      const s = '#E2B48C', b = '#D6A24B';
      return `${face(s, { shirt: '#2D5A42' })}
        <path d="M29 39 C29 25 38 19 48 19 C58 19 67 25 67 39 Z" fill="${b}"/>
        <rect x="27.5" y="35" width="41" height="7" rx="3.5" fill="#B9862F"/>
        <circle cx="48" cy="17" r="4" fill="#B9862F"/>`; } },
    bubble: { label: 'Blip', bg: '#1B3B2B', draw: () => `
        <path d="M24 30 H72 C77 30 80 33 80 38 V62 C80 67 77 70 72 70 H44 L33 79 C30 81 28 79 28 76 V70 H24 C19 70 16 67 16 62 V38 C16 33 19 30 24 30 Z" fill="#2D5A42"/>
        <rect x="31" y="44" width="5" height="12" rx="2.5" fill="#fff"/>
        <rect x="40" y="38" width="5" height="24" rx="2.5" fill="#fff"/>
        <rect x="49" y="42" width="5" height="16" rx="2.5" fill="#fff"/>
        <rect x="58" y="46" width="5" height="8" rx="2.5" fill="#fff"/>
        <circle cx="74" cy="28" r="9" fill="#58B889"/>
        <path d="M70 28.5 L73 31.5 L78.5 25.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` },
    mochi: { label: 'Mochi', bg: '#FFE9C7', draw: () => `
        <path d="M25 50 L30 22 L46 38 Z" fill="#F0A35E"/><path d="M71 50 L66 22 L50 38 Z" fill="#F0A35E"/>
        <path d="M30 42 L32 29 L40 38 Z" fill="#F7C9A0"/><path d="M66 42 L64 29 L56 38 Z" fill="#F7C9A0"/>
        <ellipse cx="48" cy="58" rx="26" ry="24" fill="#F0A35E"/>
        <ellipse cx="48" cy="66" rx="13" ry="10" fill="#FFF3E4"/>
        <circle cx="39" cy="55" r="2.6" fill="#1B241F"/><circle cx="57" cy="55" r="2.6" fill="#1B241F"/>
        <path d="M46 62 H50 L48 64.5 Z" fill="#C2562E"/>
        <path d="M48 64.5 Q45 68 42.5 66 M48 64.5 Q51 68 53.5 66" fill="none" stroke="#1B241F" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M26 62 H16 M27 67 H18 M70 62 H80 M69 67 H78" stroke="#8A5A33" stroke-width="1.3" stroke-linecap="round"/>` },
  };

  function avatarSVG(id, { size = 96, title = true } = {}) {
    const a = AVATARS[id];
    if (!a) return '';
    const uidc = `av-${id}-${Math.random().toString(36).slice(2, 7)}`;
    return `<svg viewBox="0 0 96 96" width="${size}" height="${size}" role="img" aria-label="${title ? a.label + ' avatar' : ''}" xmlns="http://www.w3.org/2000/svg">
      <defs><clipPath id="${uidc}"><circle cx="48" cy="48" r="48"/></clipPath></defs>
      <g clip-path="url(#${uidc})"><rect width="96" height="96" fill="${a.bg}"/>${a.draw()}</g></svg>`;
  }

  const api = { AVATARS, AVATAR_IDS: Object.keys(AVATARS), avatarSVG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
