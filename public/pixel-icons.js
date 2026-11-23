// Pixel-art UI icons, drawn on a small grid and rendered as crisp SVG rects
// (the same style as the golden trophies in trophy-art.js).
//
// Each icon is a list of rows; one character per pixel:
//   #  the icon colour (the `color` argument, else currentColor)
//   d  the icon colour, dimmed
//   k  dark detail       h  light highlight
//   y  gold              o  orange             .  empty
// Rows may be shorter than the grid; they are padded with empty pixels.
const TONES = { k: '#0b0b16', h: '#f4f1ff', y: '#ffc72c', o: '#ff9f1c' };

const ICONS = {
  home: [
    '.....##.....',
    '....####....',
    '...######...',
    '..########..',
    '.##########.',
    '############',
    '..########..',
    '..#kk#hh##..',
    '..#kk#hh##..',
    '..#kk#####..',
    '..#kk#####..',
    '.##########.',
  ],
  controller: [
    '',
    '',
    '..########..',
    '.#k######k#.',
    '#kkk####k#k#',
    '##k######k##',
    '############',
    '####....####',
    '###......###',
    '.#........#.',
  ],
  calendar: [
    '...#....#...',
    '###k####k###',
    '############',
    '#hhhhhhhhhh#',
    '#hkkhkkhkkh#',
    '#hkkhkkhkkh#',
    '#hhhhhhhhhh#',
    '#hkkhkkh##h#',
    '#hkkhkkh##h#',
    '#hhhhhhhhhh#',
    '############',
  ],
  chart: [
    '',
    '.........##.',
    '.........##.',
    '.........##.',
    '.....##..##.',
    '.....##..##.',
    '.....##..##.',
    '.##..##..##.',
    '.##..##..##.',
    '.##..##..##.',
    'dddddddddddd',
  ],
  plug: [
    '..##....##..',
    '..##....##..',
    '.##########.',
    '.#hh#######.',
    '.##########.',
    '..########..',
    '...######...',
    '.....##.....',
    '.....##.....',
    '......##....',
    '.......####.',
    '..........##',
  ],
  sync: [
    '.......#....',
    '.......##...',
    '##########..',
    '##########..',
    '.......##...',
    '.......#....',
    '....#.......',
    '...##.......',
    '..##########',
    '..##########',
    '...##.......',
    '....#.......',
  ],
  // The 128bit logo mark: three dark bars (the favicon's design).
  logo: [
    '',
    '',
    '',
    '...........kk',
    '...........kk',
    '...........kk',
    '.......kk..kk',
    '.......kk..kk',
    '.......kk..kk',
    '...kk..kk..kk',
    '...kk..kk..kk',
    '...kk..kk..kk',
    '...kk..kk..kk',
    '',
    '',
    '',
  ],
  show: [
    '..#.....#...',
    '...#...#....',
    '....#.#.....',
    '############',
    '#kkkkkkkk#h#',
    '#khhkkkkk###',
    '#khkkkkkk#h#',
    '#kkkkkkkk###',
    '#kkkkkkkk#h#',
    '############',
    '.##......##.',
  ],
  movie: [
    '',
    '##hh##hh##hh',
    '#hh##hh##hh#',
    '',
    '############',
    '#hh##hh##hh#',
    '############',
    '############',
    '#d########d#',
    '#d########d#',
    '############',
  ],
  anime: [
    '.....##.....',
    '....####....',
    '....####....',
    '##...##...##',
    '####.hh.####',
    '.###hkkh###.',
    '..##hkkh##..',
    '....#hh#....',
    '..###..###..',
    '..###..###..',
    '...#....#...',
  ],
  book: [
    '',
    '.####..####.',
    '#hhhh##hhhh#',
    '#hkkh##hkkh#',
    '#hhhh##hhhh#',
    '#hkkh##hkkh#',
    '#hhhh##hhhh#',
    '#hkkh##hkkh#',
    '#hhhh##hhhh#',
    '#####kk#####',
    '.####..####.',
  ],
  audiobook: [
    '...######...',
    '..########..',
    '.###....###.',
    '.##......##.',
    '##........##',
    '##........##',
    '####....####',
    '#hh#....#hh#',
    '####....####',
    '####....####',
    '.##......##.',
  ],
  comic: [
    '#....#.....#',
    '.##..##..##.',
    '.#########..',
    '..##hhhh##..',
    '###hhkkhh###',
    '.##hhkkhh##.',
    '..#hhkkhh#..',
    '.##hhhhhh##.',
    '###hhkkhh###',
    '..##hhhh##..',
    '.##########.',
    '#.#..##..#.#',
  ],
  manga: [
    '',
    '..########..',
    '.##########.',
    '##hhhhhhhh##',
    '##kkkkkk####',
    '############',
    '##kkkk######',
    '.##########.',
    '..########..',
    '....##......',
    '...##.......',
    '..#.........',
  ],
  podcast: [
    '....####....',
    '...#hh###...',
    '...#h####...',
    '...######...',
    '...#k#k##...',
    '...######...',
    '.#.######.#.',
    '.#..####..#.',
    '..#......#..',
    '...######...',
    '.....##.....',
    '...######...',
  ],
  music: [
    '',
    '....#######.',
    '....#######.',
    '....#.....#.',
    '....#.....#.',
    '....#.....#.',
    '....#.....#.',
    '.####..####.',
    '#####.#####.',
    '#####.#####.',
    '.###...###..',
  ],
  course: [
    '',
    '.....##.....',
    '...######...',
    '.##########.',
    '############',
    '.##########.',
    '..########.#',
    '..##kkkk##.#',
    '..########.#',
    '..........##',
  ],
  other: [
    '',
    '.##########.',
    '############',
    '#####hh#####',
    '############',
    '.#d######d#.',
    '.#d##kk##d#.',
    '.#d######d#.',
    '.#d######d#.',
    '.#d######d#.',
    '.##########.',
  ],
  play: [
    '',
    '..#.........',
    '..###.......',
    '..#####.....',
    '..#######...',
    '..#########.',
    '..#########.',
    '..#######...',
    '..#####.....',
    '..###.......',
    '..#.........',
  ],
  check: [
    '',
    '',
    '..........##',
    '.........###',
    '........###.',
    '##.....###..',
    '###...###...',
    '.###.###....',
    '..#####.....',
    '...###......',
  ],
  fire: [
    '.....#......',
    '....##......',
    '....###.....',
    '...####..#..',
    '...#####.##.',
    '..####y####.',
    '.####yy####.',
    '.###yyyy###.',
    '.###yhhy###.',
    '.####hh####.',
    '..########..',
    '...######...',
  ],
  list: [
    '....####....',
    '.###k##k###.',
    '.#hhhhhhhh#.',
    '.#hkkkkkhh#.',
    '.#hhhhhhhh#.',
    '.#hkkkkkkh#.',
    '.#hhhhhhhh#.',
    '.#hkkkkhhh#.',
    '.#hhhhhhhh#.',
    '.#hkkkkkkh#.',
    '.#hhhhhhhh#.',
    '.##########.',
  ],
  trophy: [
    '..########..',
    '############',
    '#.#h######.#',
    '#.#h######.#',
    '.##h######..',
    '..########..',
    '...######...',
    '.....##.....',
    '.....##.....',
    '...######...',
    '..########..',
  ],
  arrow: [
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '....####....',
    '############',
    '.##########.',
    '..########..',
    '...######...',
    '....####....',
    '.....##.....',
  ],
  // Rotated in 90° steps it reads as a chasing loader.
  spinner: [
    '....hhhh....',
    '.dd.hhhh.hh.',
    '.dd......hh.',
    '............',
    'dd........##',
    'dd........##',
    'dd........##',
    'dd........##',
    '............',
    '.dd......##.',
    '.dd.dddd.##.',
    '....dddd....',
  ],
  star: [
    '.....##.....',
    '.....##.....',
    '....####....',
    '############',
    '.##########.',
    '..########..',
    '...######...',
    '..###..###..',
    '..##....##..',
    '.##......##.',
  ],
};

// Runs of the same tone on a row become one rect.
const cache = new Map();
function rects(name) {
  if (cache.has(name)) return cache.get(name);
  const rows = ICONS[name];
  const grid = Math.max(rows.length, ...rows.map((r) => r.length));
  const out = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const t = row[x];
      let w = 1;
      while (row[x + w] === t) w++;
      if (t !== '.') out.push([x, y, w, t]);
      x += w;
    }
  });
  const v = { grid, out };
  cache.set(name, v);
  return v;
}

export const PX_ICONS = Object.keys(ICONS);

/**
 * SVG markup for a pixel icon. `size` in CSS px; best at a multiple of the grid
 * (12 → 12, 24, 36, 48). `color` is any CSS colour (vars too); default currentColor.
 */
export function pxIcon(name, size = 24, color = 'currentColor', { cls = '', label = '' } = {}) {
  const { grid, out } = rects(ICONS[name] ? name : 'other');
  const fill = (t) => (t === '#' ? color : t === 'd' ? color : TONES[t]);
  const body = out.map(([x, y, w, t]) => `<rect x="${x}" y="${y}" width="${w}" height="1" fill="${fill(t)}"${t === 'd' ? ' fill-opacity=".45"' : ''}/>`).join('');
  const a11y = label ? `role="img" aria-label="${label.replace(/"/g, '&quot;')}"` : 'aria-hidden="true"';
  return `<svg class="pxi${cls ? ' ' + cls : ''}" viewBox="0 0 ${grid} ${grid}" width="${size}" height="${size}" shape-rendering="crispEdges" ${a11y}>${body}</svg>`;
}

// Library item types (and audiobooks) → their icon.
const TYPE_ICON = { game: 'controller', movie: 'movie', show: 'show', book: 'book', audiobook: 'audiobook', anime: 'anime', manga: 'manga', comic: 'comic', podcast: 'podcast', music: 'music', course: 'course', other: 'other' };
export const typeIconName = (type) => TYPE_ICON[type] ?? 'other';
