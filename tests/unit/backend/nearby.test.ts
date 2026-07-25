import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Prisma } from '@prisma/client';

const dbMocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
}));

vi.mock('../../../backend/services/db', () => ({
  db: { $queryRaw: dbMocks.queryRaw },
}));

import {
  EARTH_RADIUS_METERS,
  MAX_RADIUS_METERS,
  bearingDegrees,
  boundingBox,
  candidateCoordinates,
  coordinatesFromAddress,
  findNearbyContacts,
  haversineMeters,
  isValidCoordinates,
  rankNearbyCandidates,
  type Coordinates,
  type NearbyCandidate,
} from '../../../backend/services/nearby';

// Well-known Moscow landmarks. Reference distances were derived independently of
// the implementation (spherical law of cosines, R = 6 371 000 m).
const KREMLIN: Coordinates = { latitude: 55.7539, longitude: 37.6208 };
const BOLSHOI: Coordinates = { latitude: 55.7602, longitude: 37.6186 };
const MOSCOW_CITY: Coordinates = { latitude: 55.7473, longitude: 37.5377 };
const VDNKH: Coordinates = { latitude: 55.8299, longitude: 37.6371 };
const SAINT_PETERSBURG: Coordinates = { latitude: 59.9386, longitude: 30.3141 };

const ORG_ID = '11111111-1111-4111-8111-111111111111';

function toRadians(value: number): number {
  return value * (Math.PI / 180);
}

/** Independent cross-check: the spherical law of cosines, not the haversine. */
function lawOfCosinesMeters(from: Coordinates, to: Coordinates): number {
  return EARTH_RADIUS_METERS * Math.acos(
    Math.sin(toRadians(from.latitude)) * Math.sin(toRadians(to.latitude))
    + Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude))
      * Math.cos(toRadians(to.longitude - from.longitude)),
  );
}

describe('haversine distance', () => {
  it('matches the known Kremlin to Moscow-City distance', () => {
    expect(haversineMeters(KREMLIN, MOSCOW_CITY)).toBeCloseTo(5251.93, 1);
  });

  it('matches the known Kremlin to Saint Petersburg distance', () => {
    expect(haversineMeters(KREMLIN, SAINT_PETERSBURG)).toBeCloseTo(634496.39, 1);
  });

  it('agrees with the spherical law of cosines for Moscow landmarks', () => {
    for (const target of [BOLSHOI, MOSCOW_CITY, VDNKH, SAINT_PETERSBURG]) {
      expect(haversineMeters(KREMLIN, target)).toBeCloseTo(lawOfCosinesMeters(KREMLIN, target), 3);
    }
  });

  it('reproduces a one-degree equatorial arc', () => {
    expect(haversineMeters(
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
    )).toBeCloseTo(EARTH_RADIUS_METERS * Math.PI / 180, 6);
  });

  it('is symmetric and zero at the same point', () => {
    expect(haversineMeters(KREMLIN, VDNKH)).toBeCloseTo(haversineMeters(VDNKH, KREMLIN), 8);
    expect(haversineMeters(KREMLIN, KREMLIN)).toBe(0);
  });

  it('returns Infinity for coordinates that are not on the globe', () => {
    expect(haversineMeters({ latitude: 91, longitude: 37 }, KREMLIN)).toBe(Number.POSITIVE_INFINITY);
    expect(haversineMeters(KREMLIN, { latitude: 55, longitude: 181 })).toBe(Number.POSITIVE_INFINITY);
    expect(haversineMeters(KREMLIN, { latitude: Number.NaN, longitude: 37 })).toBe(Number.POSITIVE_INFINITY);
  });

  it('reports cardinal bearings so the UI can point at a contact', () => {
    const centre = { latitude: 0, longitude: 0 };
    expect(bearingDegrees(centre, { latitude: 1, longitude: 0 })).toBeCloseTo(0, 8);
    expect(bearingDegrees(centre, { latitude: 0, longitude: 1 })).toBeCloseTo(90, 8);
    expect(bearingDegrees(centre, { latitude: -1, longitude: 0 })).toBeCloseTo(180, 8);
    expect(bearingDegrees(centre, { latitude: 0, longitude: -1 })).toBeCloseTo(270, 8);
    // VDNKh sits north-north-east of the Kremlin.
    expect(bearingDegrees(KREMLIN, VDNKH)).toBeGreaterThan(0);
    expect(bearingDegrees(KREMLIN, VDNKH)).toBeLessThan(45);
  });
});

describe('bounding box prefilter', () => {
  it('fully contains the circle it approximates', () => {
    const radius = 10_000;
    const box = boundingBox(KREMLIN, radius);

    // Walk the rim of the circle; every point must fall inside the box.
    for (let bearing = 0; bearing < 360; bearing += 5) {
      const angular = radius / EARTH_RADIUS_METERS;
      const latitude = Math.asin(
        Math.sin(toRadians(KREMLIN.latitude)) * Math.cos(angular)
        + Math.cos(toRadians(KREMLIN.latitude)) * Math.sin(angular) * Math.cos(toRadians(bearing)),
      ) * (180 / Math.PI);
      const longitude = KREMLIN.longitude + Math.atan2(
        Math.sin(toRadians(bearing)) * Math.sin(angular) * Math.cos(toRadians(KREMLIN.latitude)),
        Math.cos(angular) - Math.sin(toRadians(KREMLIN.latitude)) * Math.sin(toRadians(latitude)),
      ) * (180 / Math.PI);

      expect(latitude).toBeGreaterThanOrEqual(box.min_latitude - 1e-9);
      expect(latitude).toBeLessThanOrEqual(box.max_latitude + 1e-9);
      expect(longitude).toBeGreaterThanOrEqual(box.min_longitude - 1e-9);
      expect(longitude).toBeLessThanOrEqual(box.max_longitude + 1e-9);
    }
  });

  it('flags an antimeridian wrap for Chukotka instead of producing an empty range', () => {
    const box = boundingBox({ latitude: 66.16, longitude: 179.98 }, 50_000);

    expect(box.wraps_antimeridian).toBe(true);
    expect(box.spans_all_longitudes).toBe(false);
    expect(box.min_longitude).toBeGreaterThan(0);
    expect(box.max_longitude).toBeLessThan(0);
  });

  it('gives up on longitude narrowing near the pole', () => {
    const box = boundingBox({ latitude: 89.99, longitude: 100 }, 50_000);

    expect(box.spans_all_longitudes).toBe(true);
    expect(box.min_longitude).toBe(-180);
    expect(box.max_longitude).toBe(180);
    expect(box.max_latitude).toBeLessThanOrEqual(90);
  });
});

describe('coordinates read out of the contact address JSON', () => {
  it('accepts canonical keys, short aliases, and numeric strings', () => {
    expect(coordinatesFromAddress({ city: 'Москва', latitude: 55.7539, longitude: 37.6208 }))
      .toEqual(KREMLIN);
    expect(coordinatesFromAddress({ lat: 55.7539, lng: 37.6208 })).toEqual(KREMLIN);
    expect(coordinatesFromAddress({ latitude: '55.7539', longitude: '37.6208' })).toEqual(KREMLIN);
    expect(coordinatesFromAddress({ latitude: ' -0.5 ', longitude: '.25' }))
      .toEqual({ latitude: -0.5, longitude: 0.25 });
  });

  it('rejects addresses that carry no usable coordinates', () => {
    expect(coordinatesFromAddress(null)).toBeNull();
    expect(coordinatesFromAddress(undefined)).toBeNull();
    expect(coordinatesFromAddress('Москва, Красная площадь, 1')).toBeNull();
    expect(coordinatesFromAddress([55.7539, 37.6208])).toBeNull();
    expect(coordinatesFromAddress({ city: 'Москва', street: 'Тверская' })).toBeNull();
    expect(coordinatesFromAddress({ latitude: 55.7539 })).toBeNull();
    expect(coordinatesFromAddress({ latitude: 'сорок', longitude: 'пять' })).toBeNull();
    expect(coordinatesFromAddress({ latitude: 90.5, longitude: 37 })).toBeNull();
    expect(coordinatesFromAddress({ latitude: 55, longitude: -180.5 })).toBeNull();
    expect(coordinatesFromAddress({ latitude: Number.NaN, longitude: 37 })).toBeNull();
    expect(coordinatesFromAddress({ latitude: null, longitude: null })).toBeNull();
  });

  it('accepts the exact coordinate bounds', () => {
    expect(isValidCoordinates({ latitude: -90, longitude: -180 })).toBe(true);
    expect(isValidCoordinates({ latitude: 90, longitude: 180 })).toBe(true);
    expect(isValidCoordinates({ latitude: 90.0001, longitude: 0 })).toBe(false);
  });

  it('prefers explicit coordinates over the address JSON', () => {
    const candidate: NearbyCandidate = {
      contact_id: 'a',
      latitude: 55.7539,
      longitude: 37.6208,
      address: { latitude: 0, longitude: 0 },
    };

    expect(candidateCoordinates(candidate)).toEqual(KREMLIN);
    expect(candidateCoordinates({ contact_id: 'b', address: { lat: 55.7539, lng: 37.6208 } }))
      .toEqual(KREMLIN);
    expect(candidateCoordinates({ contact_id: 'c', latitude: null, longitude: null })).toBeNull();
  });
});

describe('ranking candidates by distance', () => {
  const candidates: NearbyCandidate[] = [
    { contact_id: 'spb', address: { latitude: SAINT_PETERSBURG.latitude, longitude: SAINT_PETERSBURG.longitude } },
    { contact_id: 'vdnkh', address: { latitude: VDNKH.latitude, longitude: VDNKH.longitude } },
    { contact_id: 'bolshoi', address: { lat: BOLSHOI.latitude, lng: BOLSHOI.longitude } },
    { contact_id: 'city', address: { latitude: MOSCOW_CITY.latitude, longitude: MOSCOW_CITY.longitude } },
  ];

  it('returns the nearest contact first', () => {
    const hits = rankNearbyCandidates(KREMLIN, candidates, MAX_RADIUS_METERS, 50);

    expect(hits.map((hit) => hit.contact_id)).toEqual(['bolshoi', 'city', 'vdnkh']);
    expect(hits[0].distance_meters).toBeCloseTo(713.92, 1);
    expect(hits[1].distance_meters).toBeCloseTo(5251.93, 1);
    expect(hits[2].distance_meters).toBeCloseTo(8512.03, 1);
  });

  it('drops everything beyond the radius', () => {
    expect(rankNearbyCandidates(KREMLIN, candidates, 1_000, 50).map((h) => h.contact_id))
      .toEqual(['bolshoi']);
    expect(rankNearbyCandidates(KREMLIN, candidates, 6_000, 50).map((h) => h.contact_id))
      .toEqual(['bolshoi', 'city']);
    expect(rankNearbyCandidates(KREMLIN, candidates, 100, 50)).toEqual([]);
  });

  it('never returns anything past the maximum radius, even if asked', () => {
    const hits = rankNearbyCandidates(KREMLIN, candidates, Number.MAX_SAFE_INTEGER, 50);

    expect(hits.map((hit) => hit.contact_id)).not.toContain('spb');
    expect(hits.every((hit) => hit.distance_meters <= MAX_RADIUS_METERS)).toBe(true);
  });

  it('treats the radius as inclusive', () => {
    const distance = haversineMeters(KREMLIN, BOLSHOI);

    expect(rankNearbyCandidates(KREMLIN, candidates, distance, 50).map((h) => h.contact_id))
      .toEqual(['bolshoi']);
  });

  it('excludes contacts whose address has no coordinates', () => {
    const mixed: NearbyCandidate[] = [
      { contact_id: 'no-address', address: null },
      { contact_id: 'text-address', address: 'Москва, Тверская улица, 7' },
      { contact_id: 'address-without-coords', address: { city: 'Москва', postal_code: '101000' } },
      { contact_id: 'half-coords', address: { latitude: 55.7539 } },
      { contact_id: 'garbage-coords', address: { latitude: 'север', longitude: 'запад' } },
      { contact_id: 'out-of-range', address: { latitude: 155.7539, longitude: 37.6208 } },
      { contact_id: 'geocoded', address: { latitude: BOLSHOI.latitude, longitude: BOLSHOI.longitude } },
    ];

    expect(rankNearbyCandidates(KREMLIN, mixed, 10_000, 50).map((h) => h.contact_id))
      .toEqual(['geocoded']);
  });

  it('applies the limit after sorting, and breaks ties deterministically', () => {
    const sameSpot: NearbyCandidate[] = ['delta', 'alpha', 'charlie'].map((id) => ({
      contact_id: id,
      address: { latitude: BOLSHOI.latitude, longitude: BOLSHOI.longitude },
    }));

    expect(rankNearbyCandidates(KREMLIN, [...candidates, ...sameSpot], 10_000, 2)
      .map((hit) => hit.contact_id)).toEqual(['alpha', 'bolshoi']);
    expect(rankNearbyCandidates(KREMLIN, candidates, 10_000, 0)).toEqual([]);
  });

  it('returns nothing when the origin itself is off the globe', () => {
    expect(rankNearbyCandidates({ latitude: 100, longitude: 37 }, candidates, 10_000, 50)).toEqual([]);
  });
});

describe('findNearbyContacts query', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.queryRaw.mockResolvedValue([]);
  });

  const baseParams = {
    orgId: ORG_ID,
    origin: KREMLIN,
    radiusMeters: 5_000,
    limit: 50,
    visibleIds: null as string[] | null,
  };

  function lastQuery(): Prisma.Sql {
    return dbMocks.queryRaw.mock.calls[0][0] as Prisma.Sql;
  }

  it('scopes every lookup to the organization', async () => {
    await findNearbyContacts(baseParams);

    const query = lastQuery();
    expect(query.sql).toContain('c.organization_id =');
    expect(query.values).toContain(ORG_ID);
  });

  it('excludes archived contacts unless a status is asked for', async () => {
    await findNearbyContacts(baseParams);
    expect(lastQuery().sql).toContain(`c.status <> 'archived'`);

    dbMocks.queryRaw.mockClear();
    await findNearbyContacts({ ...baseParams, status: 'inactive' });
    expect(lastQuery().sql).toContain('c.status =');
    expect(lastQuery().values).toContain('inactive');
  });

  it('restricts the query to the visibility cone for members', async () => {
    const visibleIds = [
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ];

    await findNearbyContacts({ ...baseParams, visibleIds });

    const query = lastQuery();
    expect(query.sql).toContain('c.assigned_to IN');
    expect(query.sql).toContain('c.created_by IN');
    for (const id of visibleIds) {
      expect(query.values).toContain(id);
    }
  });

  it('adds no cone restriction for owner and admin', async () => {
    await findNearbyContacts({ ...baseParams, visibleIds: null });

    expect(lastQuery().sql).not.toContain('c.assigned_to IN');
  });

  it('never queries when the requester can see nobody', async () => {
    expect(await findNearbyContacts({ ...baseParams, visibleIds: [] })).toEqual([]);
    expect(dbMocks.queryRaw).not.toHaveBeenCalled();
  });

  it('rejects an off-globe origin without touching the database', async () => {
    for (const origin of [
      { latitude: 91, longitude: 37 },
      { latitude: -90.1, longitude: 37 },
      { latitude: 55, longitude: 180.1 },
      { latitude: 55, longitude: Number.NaN },
    ]) {
      expect(await findNearbyContacts({ ...baseParams, origin })).toEqual([]);
    }

    expect(dbMocks.queryRaw).not.toHaveBeenCalled();
  });

  it('turns prefiltered rows into sorted hits and drops the ones outside the radius', async () => {
    dbMocks.queryRaw.mockResolvedValue([
      { contact_id: 'vdnkh', latitude: VDNKH.latitude, longitude: VDNKH.longitude },
      { contact_id: 'bolshoi', latitude: BOLSHOI.latitude, longitude: BOLSHOI.longitude },
      { contact_id: 'city', latitude: MOSCOW_CITY.latitude, longitude: MOSCOW_CITY.longitude },
    ]);

    const hits = await findNearbyContacts({ ...baseParams, radiusMeters: 6_000 });

    expect(hits.map((hit) => hit.contact_id)).toEqual(['bolshoi', 'city']);
    expect(hits[0].distance_meters).toBeCloseTo(713.92, 1);
    expect(hits[0].bearing_degrees).toBeGreaterThanOrEqual(0);
    expect(hits[0].bearing_degrees).toBeLessThan(360);
  });

  it('caps the radius at the maximum before building the box', async () => {
    await findNearbyContacts({ ...baseParams, radiusMeters: 5_000_000 });

    const box = boundingBox(KREMLIN, MAX_RADIUS_METERS);
    expect(lastQuery().values).toContain(box.min_latitude);
    expect(lastQuery().values).toContain(box.max_latitude);
  });
});

describe('GET /contacts/nearby validation', () => {
  let app: ReturnType<typeof Fastify>;
  const nearbyHandler = vi.fn(async (request: { query: unknown }, reply: { send: (payload: unknown) => unknown }) => {
    reply.send({ data: [], meta: request.query });
  });

  beforeEach(async () => {
    vi.clearAllMocks();

    // The contacts controller is a moving target (other features land in it), so the
    // mock answers for whatever method the route file happens to register.
    vi.doMock('../../../backend/api/controllers/contacts', () => ({
      ContactsController: new Proxy({} as Record<string, unknown>, {
        get: (_target, property) => {
          if (typeof property !== 'string' || property === 'then') return undefined;
          if (property === 'nearby') return nearbyHandler;
          return async (_request: unknown, reply: { send: (payload: unknown) => unknown }) => {
            reply.send({ data: {}, meta: {} });
          };
        },
      }),
    }));

    const { default: contactsRoutes } = await import('../../../backend/api/routes/contacts');

    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('jwtVerify', async function jwtVerify() {
      return undefined;
    });
    await app.register(contactsRoutes, { prefix: '/contacts' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.doUnmock('../../../backend/api/controllers/contacts');
    vi.resetModules();
  });

  const rejected: Array<[string, string]> = [
    ['latitude above 90', '?latitude=90.5&longitude=37.6208'],
    ['latitude below -90', '?latitude=-90.5&longitude=37.6208'],
    ['longitude above 180', '?latitude=55.7539&longitude=180.5'],
    ['longitude below -180', '?latitude=55.7539&longitude=-180.5'],
    ['missing latitude', '?longitude=37.6208'],
    ['missing longitude', '?latitude=55.7539'],
    ['non-numeric latitude', '?latitude=север&longitude=37.6208'],
    ['empty latitude', '?latitude=&longitude=37.6208'],
    ['radius over the maximum', `?latitude=55.7539&longitude=37.6208&radius_m=${MAX_RADIUS_METERS + 1}`],
    ['zero radius', '?latitude=55.7539&longitude=37.6208&radius_m=0'],
    ['negative radius', '?latitude=55.7539&longitude=37.6208&radius_m=-500'],
    ['limit over 100', '?latitude=55.7539&longitude=37.6208&limit=500'],
    ['fractional limit', '?latitude=55.7539&longitude=37.6208&limit=2.5'],
    ['unknown contact type', '?latitude=55.7539&longitude=37.6208&type=supplier'],
    ['unknown scope', '?latitude=55.7539&longitude=37.6208&scope=everyone'],
  ];

  for (const [label, query] of rejected) {
    it(`rejects ${label}`, async () => {
      const response = await app.inject({ method: 'GET', url: `/contacts/nearby${query}` });

      expect(response.statusCode).toBe(400);
      expect(nearbyHandler).not.toHaveBeenCalled();
    });
  }

  it('accepts a valid position and applies the defaults', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/contacts/nearby?latitude=55.7539&longitude=37.6208',
    });

    expect(response.statusCode).toBe(200);
    expect(nearbyHandler).toHaveBeenCalledTimes(1);
    expect(response.json().meta).toMatchObject({
      latitude: 55.7539,
      longitude: 37.6208,
      radius_m: 5_000,
      limit: 50,
    });
  });

  it('accepts the extreme legal coordinates and the maximum radius', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/contacts/nearby?latitude=-90&longitude=180&radius_m=${MAX_RADIUS_METERS}&limit=100&scope=subtree&type=lead`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().meta).toMatchObject({
      latitude: -90,
      longitude: 180,
      radius_m: MAX_RADIUS_METERS,
      limit: 100,
      scope: 'subtree',
      type: 'lead',
    });
  });
});
