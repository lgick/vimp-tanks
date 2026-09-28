import { withWallHeights } from './wallHeights.js';
import canopy from './canopy.js';
import downtown from './downtown.js';
import garden from './garden.js';
import overpass from './overpass.js';
import poolMini from './pool_mini.js';
import terraces from './terraces.js';

// `game.wallHeights` — высоты стен для пули (./wallHeights.js)
export default Object.fromEntries(
  Object.entries({
    canopy,
    downtown,
    garden,
    overpass,
    'pool mini': poolMini,
    terraces,
  }).map(([name, map]) => [name, withWallHeights(map)]),
);
