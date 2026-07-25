import { Prisma } from '@prisma/client';
import { db } from './db';

/**
 * Nearby leads — "what is around me right now" for field reps.
 *
 * Coordinates are read out of the contact's `address` JSON only. Contacts whose
 * address has no usable latitude/longitude are simply skipped: we deliberately do
 * NOT geocode, because that would introduce an external provider (and any Russian
 * geocoding has to be Yandex, which is a separate decision).
 *
 * The lookup is a bounding-box prefilter in SQL followed by an exact haversine in
 * TypeScript. The box is computed from the spherical cap around the origin, so it
 * can never clip a contact that is actually inside the radius, and it keeps the
 * query from dragging every contact in the org back into Node.
 */

/** Mean Earth radius used by the haversine formula. */
export const EARTH_RADIUS_METERS = 6_371_000;

/** Default search radius when the caller does not ask for one (5 km). */
export const DEFAULT_RADIUS_METERS = 5_000;

/** Widest radius a single nearby lookup may ask for (100 km). */
export const MAX_RADIUS_METERS = 100_000;

/** Most rows the bounding-box prefilter may hand back to Node in one lookup. */
export const MAX_CANDIDATES = 2_000;

/** Matches a plain decimal number, e.g. `55.7558`, `-37.6`, `.5`. No exponents. */
const NUMERIC_TEXT = /^[+-]?[0-9]*\.?[0-9]+$/;

/** The same pattern as a POSIX regex — kept backslash-free so SQL quoting is safe. */
const NUMERIC_TEXT_SQL = '^[+-]?[0-9]*[.]?[0-9]+$';

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type BoundingBox = {
  min_latitude: number;
  max_latitude: number;
  min_longitude: number;
  max_longitude: number;
  /** The longitude span crosses ±180° (Chukotka), so it must be OR-ed, not BETWEEN-ed. */
  wraps_antimeridian: boolean;
  /** The circle swallows a pole (or the radius is huge) — every meridian is in range. */
  spans_all_longitudes: boolean;
};

/**
 * A contact that may or may not turn out to have coordinates. Either the caller
 * supplies already-extracted `latitude`/`longitude` (the SQL prefilter does), or it
 * hands over the raw `address` JSON and we dig the coordinates out of it.
 */
export type NearbyCandidate = {
  contact_id: string;
  latitude?: number | null;
  longitude?: number | null;
  address?: unknown;
};

export type NearbyContactHit = {
  contact_id: string;
  latitude: number;
  longitude: number;
  /** Great-circle distance from the origin, in metres. */
  distance_meters: number;
  /** Initial compass bearing from the origin, 0–360°, so the UI can point at it. */
  bearing_degrees: number;
};

export type FindNearbyContactsParams = {
  orgId: string;
  origin: Coordinates;
  radiusMeters: number;
  limit: number;
  /** From `getVisibleUserIds` — `null` means owner/admin, i.e. no per-user restriction. */
  visibleIds: string[] | null;
  status?: 'active' | 'inactive' | 'archived';
  type?: 'lead' | 'customer' | 'partner' | 'other';
  maxCandidates?: number;
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function toRadians(value: number): number {
  return value * (Math.PI / 180);
}

function toDegrees(value: number): number {
  return value * (180 / Math.PI);
}

export function isValidCoordinates(value: Coordinates | null | undefined): value is Coordinates {
  return value !== null
    && value !== undefined
    && Number.isFinite(value.latitude)
    && Number.isFinite(value.longitude)
    && value.latitude >= -90
    && value.latitude <= 90
    && value.longitude >= -180
    && value.longitude <= 180;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!NUMERIC_TEXT.test(trimmed)) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/**
 * Pull coordinates out of a contact's `address` JSON. Accepts `latitude`/`longitude`
 * or the short `lat`/`lng` aliases, as numbers or as numeric strings. Anything else
 * — a plain string address, a missing key, an out-of-range value — yields `null`.
 */
export function coordinatesFromAddress(address: unknown): Coordinates | null {
  if (typeof address !== 'object' || address === null || Array.isArray(address)) {
    return null;
  }

  const record = address as Record<string, unknown>;
  const latitude = numberValue(record.latitude) ?? numberValue(record.lat);
  const longitude = numberValue(record.longitude) ?? numberValue(record.lng);

  if (latitude === null || longitude === null) {
    return null;
  }

  const coordinates = { latitude, longitude };
  return isValidCoordinates(coordinates) ? coordinates : null;
}

/** Coordinates for a candidate: explicit lat/lng first, otherwise dug out of the address. */
export function candidateCoordinates(candidate: NearbyCandidate): Coordinates | null {
  const direct = {
    latitude: candidate.latitude ?? Number.NaN,
    longitude: candidate.longitude ?? Number.NaN,
  };

  return isValidCoordinates(direct) ? direct : coordinatesFromAddress(candidate.address);
}

/**
 * Great-circle distance in metres. Returns `Infinity` for coordinates that are not
 * on the globe, so callers filtering by radius drop them without a special case.
 */
export function haversineMeters(from: Coordinates, to: Coordinates): number {
  if (!isValidCoordinates(from) || !isValidCoordinates(to)) {
    return Number.POSITIVE_INFINITY;
  }

  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);

  const raw = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  const a = Math.min(1, Math.max(0, raw));

  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial compass bearing from `from` to `to`, normalized to 0–360°. */
export function bearingDegrees(from: Coordinates, to: Coordinates): number {
  if (!isValidCoordinates(from) || !isValidCoordinates(to)) {
    return 0;
  }

  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const y = Math.sin(deltaLongitude) * Math.cos(toLatitude);
  const x = Math.cos(fromLatitude) * Math.sin(toLatitude)
    - Math.sin(fromLatitude) * Math.cos(toLatitude) * Math.cos(deltaLongitude);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Smallest lat/lng rectangle that fully contains the circle of `radiusMeters`
 * around `origin`. Used as a cheap prefilter — it always over-selects, never
 * under-selects, so the exact haversine afterwards is what decides membership.
 */
export function boundingBox(origin: Coordinates, radiusMeters: number): BoundingBox {
  const radius = Math.min(Math.max(0, radiusMeters), MAX_RADIUS_METERS);
  const angular = radius / EARTH_RADIUS_METERS;
  const latitudeDelta = toDegrees(angular);

  const rawMinLatitude = origin.latitude - latitudeDelta;
  const rawMaxLatitude = origin.latitude + latitudeDelta;
  const min_latitude = Math.max(-90, rawMinLatitude);
  const max_latitude = Math.min(90, rawMaxLatitude);

  // Longitude degrees narrow towards the poles: the widest longitude offset of a
  // spherical cap is asin(sin r / cos lat). When that ratio leaves [0, 1] the cap
  // has wrapped a pole and every meridian is in range.
  const cosLatitude = Math.cos(toRadians(origin.latitude));
  const ratio = cosLatitude <= 1e-12 ? Number.POSITIVE_INFINITY : Math.sin(angular) / cosLatitude;
  const spansAllLongitudes = rawMinLatitude <= -90
    || rawMaxLatitude >= 90
    || angular >= Math.PI / 2
    || !(ratio <= 1);

  if (spansAllLongitudes) {
    return {
      min_latitude,
      max_latitude,
      min_longitude: -180,
      max_longitude: 180,
      wraps_antimeridian: false,
      spans_all_longitudes: true,
    };
  }

  const longitudeDelta = toDegrees(Math.asin(ratio));
  const rawMinLongitude = origin.longitude - longitudeDelta;
  const rawMaxLongitude = origin.longitude + longitudeDelta;
  const wraps_antimeridian = rawMinLongitude < -180 || rawMaxLongitude > 180;

  return {
    min_latitude,
    max_latitude,
    min_longitude: rawMinLongitude < -180 ? rawMinLongitude + 360 : rawMinLongitude,
    max_longitude: rawMaxLongitude > 180 ? rawMaxLongitude - 360 : rawMaxLongitude,
    wraps_antimeridian,
    spans_all_longitudes: false,
  };
}

/**
 * Exact distance pass: drop candidates without usable coordinates, drop anything
 * beyond the radius, sort nearest first, and cut to `limit`. Ties break on
 * contact_id so repeated calls return the same order.
 */
export function rankNearbyCandidates(
  origin: Coordinates,
  candidates: readonly NearbyCandidate[],
  radiusMeters: number,
  limit: number,
): NearbyContactHit[] {
  if (!isValidCoordinates(origin)) {
    return [];
  }

  const radius = Math.min(Math.max(0, radiusMeters), MAX_RADIUS_METERS);
  const hits: NearbyContactHit[] = [];

  for (const candidate of candidates) {
    const coordinates = candidateCoordinates(candidate);
    if (coordinates === null) {
      continue;
    }

    const distance = haversineMeters(origin, coordinates);
    if (!Number.isFinite(distance) || distance > radius) {
      continue;
    }

    hits.push({
      contact_id: candidate.contact_id,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      distance_meters: distance,
      bearing_degrees: bearingDegrees(origin, coordinates),
    });
  }

  hits.sort((left, right) => {
    const difference = left.distance_meters - right.distance_meters;
    if (difference !== 0) {
      return difference;
    }
    return left.contact_id < right.contact_id ? -1 : left.contact_id > right.contact_id ? 1 : 0;
  });

  return hits.slice(0, Math.max(0, Math.floor(limit)));
}

// ---------------------------------------------------------------------------
// SQL prefilter
// ---------------------------------------------------------------------------

function statusFilter(status: FindNearbyContactsParams['status']): Prisma.Sql {
  if (status) {
    return Prisma.sql`AND c.status = ${status}::"ContactStatus"`;
  }
  return Prisma.sql`AND c.status <> 'archived'::"ContactStatus"`;
}

function typeFilter(type: FindNearbyContactsParams['type']): Prisma.Sql {
  if (!type) {
    return Prisma.empty;
  }
  return Prisma.sql`AND c.type = ${type}::"ContactType"`;
}

/**
 * The visibility cone, expressed in SQL. Mirrors `ownerVisibilityWhere` — a member
 * sees records assigned to someone in their cone, plus records they created that
 * were never assigned. `null` (owner/admin) adds no restriction.
 */
function visibilityFilter(visibleIds: string[] | null): Prisma.Sql {
  if (visibleIds === null) {
    return Prisma.empty;
  }

  if (visibleIds.length === 0) {
    return Prisma.sql`AND false`;
  }

  const ids = Prisma.join(visibleIds.map((id) => Prisma.sql`${id}::uuid`));
  return Prisma.sql`AND (c.assigned_to IN (${ids}) OR c.created_by IN (${ids}))`;
}

function longitudeFilter(box: BoundingBox): Prisma.Sql {
  if (box.spans_all_longitudes) {
    return Prisma.empty;
  }

  if (box.wraps_antimeridian) {
    return Prisma.sql`
      AND (
        longitude >= ${box.min_longitude}::double precision
        OR longitude <= ${box.max_longitude}::double precision
      )`;
  }

  return Prisma.sql`
    AND longitude BETWEEN ${box.min_longitude}::double precision
      AND ${box.max_longitude}::double precision`;
}

/**
 * Contacts near `origin`, nearest first. Org-scoped and cone-restricted in SQL so
 * the candidate cap can never be spent on rows the caller is not allowed to see.
 */
export async function findNearbyContacts(
  params: FindNearbyContactsParams,
): Promise<NearbyContactHit[]> {
  const { orgId, origin, radiusMeters, limit, visibleIds, status, type } = params;

  if (!isValidCoordinates(origin)) {
    return [];
  }

  if (visibleIds !== null && visibleIds.length === 0) {
    return [];
  }

  const radius = Math.min(Math.max(0, radiusMeters), MAX_RADIUS_METERS);
  const box = boundingBox(origin, radius);
  const maxCandidates = Math.max(1, Math.floor(params.maxCandidates ?? MAX_CANDIDATES));
  // Equirectangular proxy for ordering the prefilter: no trigonometry per row, and
  // accurate enough at these distances that the candidate cap only ever discards
  // contacts that were already the farthest away.
  const longitudeScale = Math.max(Math.cos(toRadians(origin.latitude)), 1e-6);

  const rows = await db.$queryRaw<Array<{ contact_id: string; latitude: number; longitude: number }>>(Prisma.sql`
    WITH scoped AS (
      SELECT
        c.id AS contact_id,
        btrim(coalesce(c.address ->> 'latitude', c.address ->> 'lat', '')) AS lat_text,
        btrim(coalesce(c.address ->> 'longitude', c.address ->> 'lng', '')) AS lng_text
      FROM "Contact" c
      WHERE c.organization_id = ${orgId}::uuid
        AND c.address IS NOT NULL
        ${statusFilter(status)}
        ${typeFilter(type)}
        ${visibilityFilter(visibleIds)}
    ),
    geo AS (
      SELECT
        contact_id,
        CASE WHEN lat_text ~ ${NUMERIC_TEXT_SQL} THEN lat_text::double precision END AS latitude,
        CASE WHEN lng_text ~ ${NUMERIC_TEXT_SQL} THEN lng_text::double precision END AS longitude
      FROM scoped
      WHERE lat_text <> '' AND lng_text <> ''
    )
    SELECT contact_id, latitude, longitude
    FROM geo
    WHERE latitude IS NOT NULL
      AND longitude IS NOT NULL
      AND latitude BETWEEN ${box.min_latitude}::double precision
        AND ${box.max_latitude}::double precision
      ${longitudeFilter(box)}
    ORDER BY (
      power(latitude - ${origin.latitude}::double precision, 2)
      + power(
          LEAST(
            abs(longitude - ${origin.longitude}::double precision),
            360 - abs(longitude - ${origin.longitude}::double precision)
          ) * ${longitudeScale}::double precision,
          2
        )
    ) ASC
    LIMIT ${maxCandidates}
  `);

  return rankNearbyCandidates(origin, rows, radius, limit);
}
