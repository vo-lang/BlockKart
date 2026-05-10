import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const defaultTerrainRecipeRelativePath = 'terrain/recipes/primitive_concept_v1.json';
export const defaultTerrainRecipePath = join(projectRoot, defaultTerrainRecipeRelativePath);

const landformKinds = new Set(['oriented_hill', 'oriented_valley', 'radial_mound', 'radial_valley']);

export function loadTerrainRecipe(recipePath = defaultTerrainRecipePath) {
  const resolvedPath = isAbsolute(recipePath) ? recipePath : join(projectRoot, recipePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Terrain recipe not found: ${resolvedPath}`);
  }
  const recipe = JSON.parse(readFileSync(resolvedPath, 'utf8'));
  validateTerrainRecipe(recipe, resolvedPath);
  return recipe;
}

export function validateTerrainRecipe(recipe, recipePath = defaultTerrainRecipePath) {
  const errors = [];
  const requireObject = (value, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path} must be an object`);
    }
  };
  const requireArray = (value, path) => {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
    }
  };
  const requireNumber = (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`${path} must be a finite number`);
    }
  };
  const requireString = (value, path) => {
    if (typeof value !== 'string' || value.length === 0) {
      errors.push(`${path} must be a non-empty string`);
    }
  };

  requireObject(recipe, 'recipe');
  requireNumber(recipe.version, 'version');
  requireString(recipe.id, 'id');
  requireObject(recipe.terrain, 'terrain');
  requireObject(recipe.track, 'track');
  requireObject(recipe.heroSegment, 'heroSegment');
  requireObject(recipe.corridor, 'corridor');
  requireArray(recipe.landforms, 'landforms');

  if (recipe.terrain) {
    for (const key of ['mapScale', 'widthUnits', 'depthUnits', 'minY', 'height', 'heightmapSize', 'splatSize']) {
      requireNumber(recipe.terrain[key], `terrain.${key}`);
    }
  }

  if (recipe.track) {
    for (const key of ['centerlineSampleCount', 'width', 'clearance', 'spawnDistanceFactor']) {
      requireNumber(recipe.track[key], `track.${key}`);
    }
    if (Array.isArray(recipe.track.controlPoints)) {
      if (recipe.track.controlPoints.length < 6) {
        errors.push('track.controlPoints must contain at least 6 points');
      }
      recipe.track.controlPoints.forEach((point, index) => {
        const prefix = `track.controlPoints[${index}]`;
        requireObject(point, prefix);
        if (point.id !== undefined) {
          requireString(point.id, `${prefix}.id`);
        }
        const hasWorldPosition = typeof point.x === 'number' && typeof point.z === 'number';
        const hasScaledPosition = typeof point.xMapScale === 'number' && typeof point.zMapScale === 'number';
        if (!hasWorldPosition && !hasScaledPosition) {
          errors.push(`${prefix} needs x/z or xMapScale/zMapScale`);
        }
        if (point.y !== undefined) {
          requireNumber(point.y, `${prefix}.y`);
        }
        if (point.width !== undefined) {
          requireNumber(point.width, `${prefix}.width`);
        }
      });
    } else {
      requireNumber(recipe.track.pointCount, 'track.pointCount');
      requireObject(recipe.track.radiusX, 'track.radiusX');
      requireObject(recipe.track.radiusZ, 'track.radiusZ');
      requireObject(recipe.track.height, 'track.height');
      requireObject(recipe.track.spawnStraighten, 'track.spawnStraighten');
    }
  }

  if (recipe.heroSegment) {
    for (const key of ['startOffset', 'centerOffset', 'endOffset']) {
      requireNumber(recipe.heroSegment[key], `heroSegment.${key}`);
    }
  }

  if (recipe.corridor) {
    for (const key of ['shoulderWidth', 'terrainBlendWidth', 'roadYOffset']) {
      requireNumber(recipe.corridor[key], `corridor.${key}`);
    }
    requireObject(recipe.corridor.heroMask, 'corridor.heroMask');
    requireObject(recipe.corridor.blend, 'corridor.blend');
    requireObject(recipe.corridor.cutReinforcement, 'corridor.cutReinforcement');
    requireObject(recipe.corridor.roadProfile, 'corridor.roadProfile');
  }

  if (Array.isArray(recipe.landforms)) {
    const ids = new Set();
    recipe.landforms.forEach((feature, index) => {
      const prefix = `landforms[${index}]`;
      requireObject(feature, prefix);
      requireString(feature.id, `${prefix}.id`);
      requireString(feature.kind, `${prefix}.kind`);
      requireNumber(feature.height, `${prefix}.height`);
      if (ids.has(feature.id)) {
        errors.push(`${prefix}.id duplicates ${feature.id}`);
      }
      ids.add(feature.id);
      if (!landformKinds.has(feature.kind)) {
        errors.push(`${prefix}.kind must be one of ${Array.from(landformKinds).join(', ')}`);
      }
      if (feature.kind === 'oriented_hill' || feature.kind === 'oriented_valley') {
        const hasTrackAnchor = feature.distanceOffset !== undefined;
        const hasWorldPosition = typeof feature.x === 'number' && typeof feature.z === 'number';
        const hasScaledPosition = typeof feature.xMapScale === 'number' && typeof feature.zMapScale === 'number';
        const hasWorldSize = typeof feature.length === 'number' && typeof feature.width === 'number';
        const hasScaledSize = typeof feature.lengthMapScale === 'number' && typeof feature.widthMapScale === 'number';
        if (hasTrackAnchor) {
          requireNumber(feature.distanceOffset, `${prefix}.distanceOffset`);
          requireNumber(feature.lateral, `${prefix}.lateral`);
        } else if (!hasWorldPosition && !hasScaledPosition) {
          errors.push(`${prefix} needs distanceOffset+lateral, x/z, or xMapScale/zMapScale`);
        }
        if (!hasWorldSize && !hasScaledSize) {
          errors.push(`${prefix} needs length/width or lengthMapScale/widthMapScale`);
        }
        if (feature.angleDeg !== undefined) {
          requireNumber(feature.angleDeg, `${prefix}.angleDeg`);
        }
      }
      if (feature.kind === 'radial_mound' || feature.kind === 'radial_valley') {
        const hasWorldPosition = typeof feature.x === 'number' && typeof feature.z === 'number';
        const hasScaledPosition = typeof feature.xMapScale === 'number' && typeof feature.zMapScale === 'number';
        const hasWorldRadius = typeof feature.radiusX === 'number' && typeof feature.radiusZ === 'number';
        const hasScaledRadius = typeof feature.radiusXMapScale === 'number' && typeof feature.radiusZMapScale === 'number';
        if (feature.distanceOffset === undefined && !hasWorldPosition && !hasScaledPosition) {
          errors.push(`${prefix} needs distanceOffset+lateral, x/z, or xMapScale/zMapScale`);
        }
        if (feature.distanceOffset !== undefined) {
          requireNumber(feature.distanceOffset, `${prefix}.distanceOffset`);
          requireNumber(feature.lateral, `${prefix}.lateral`);
        }
        if (!hasWorldRadius && !hasScaledRadius) {
          errors.push(`${prefix} needs radiusX/radiusZ or radiusXMapScale/radiusZMapScale`);
        }
      }
    });
  }

  if (errors.length > 0) {
    const label = isAbsolute(recipePath) ? relative(projectRoot, recipePath) : recipePath;
    throw new Error(`Invalid terrain recipe ${label}:\n- ${errors.join('\n- ')}`);
  }
  return true;
}

export function describeTerrainRecipe(recipe) {
  const landformCounts = recipe.landforms.reduce((counts, feature) => {
    counts[feature.kind] = (counts[feature.kind] ?? 0) + 1;
    return counts;
  }, {});
  return {
    id: recipe.id,
    name: recipe.name,
    referenceImage: recipe.target?.referenceImage,
    terrainSize: {
      width: recipe.terrain.widthUnits * recipe.terrain.mapScale,
      depth: recipe.terrain.depthUnits * recipe.terrain.mapScale,
      minY: recipe.terrain.minY,
      maxY: recipe.terrain.minY + recipe.terrain.height,
    },
    track: {
      pointCount: recipe.track.controlPoints?.length ?? recipe.track.pointCount,
      width: recipe.track.width,
      shoulderWidth: recipe.corridor.shoulderWidth,
    },
    landformCount: recipe.landforms.length,
    landformCounts,
    editObject: recipe.agentIteration?.editObject ?? defaultTerrainRecipeRelativePath,
  };
}

export const terrainRecipe = loadTerrainRecipe();
