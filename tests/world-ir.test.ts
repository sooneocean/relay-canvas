import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorldIR, worldIRSchema, type WorldIR } from '../src/shared/world-ir.js';

const transform = {
  positionM: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};
function fixture(): WorldIR {
  return {
    schemaVersion: 1,
    worldId: 'world_demo',
    sceneId: 'scene_demo',
    revision: 0,
    coordinateFrame: 'RH_Y_UP_METERS',
    timebase: { fpsNumerator: 24000, fpsDenominator: 1000 },
    durationSeconds: 6,
    entities: [
      { id: 'actor_a', label: 'Lead', kind: 'character', transform, authority: 'approved',
        provenance: { origin: 'human' } },
      { id: 'prop_window', label: 'Window', kind: 'prop', transform, authority: 'approved' },
    ],
    cameras: [
      { id: 'cam_a', label: 'A camera', transform, authority: 'approved',
        lens: { focalLengthMm: 50, sensorWidthMm: 36, focusDistanceM: 3, fStop: 2.8 } },
    ],
    shots: [
      { id: 'shot_a', label: 'Medium', cameraId: 'cam_a', startSeconds: 0, endSeconds: 3, authority: 'approved' },
      { id: 'shot_b', label: 'Close up', cameraId: 'cam_a', startSeconds: 3, endSeconds: 6, authority: 'proposed' },
    ],
    relations: [{ fromId: 'actor_a', toId: 'prop_window', kind: 'near' }],
    events: [{ id: 'event_a', subjectId: 'actor_a', atSeconds: 1, kind: 'move',
      description: 'Walk toward window', authority: 'proposed' }],
    constraints: [{ id: 'constraint_a', kind: 'identity', targetIds: ['actor_a'],
      severity: 'hard', description: 'Preserve actor identity across shots' }],
  };
}
const invalid = (value: unknown) => assert.equal(worldIRSchema.safeParse(value).success, false);

test('World IR v0 round-trips a deterministic scene without altering input', () => {
  const world = fixture();
  const copy = structuredClone(world);
  assert.deepEqual(parseWorldIR(JSON.parse(JSON.stringify(world))), world);
  assert.deepEqual(world, copy);
});

test('World IR rejects unknown schema versions and fields', () => {
  invalid({ ...fixture(), schemaVersion: 2 });
  invalid({ ...fixture(), dangerousCommand: 'rm -rf /' });
});

test('World IR rejects non-finite coordinates and non-unit rotations', () => {
  const world = fixture();
  world.entities[0].transform.positionM[0] = Number.NaN;
  invalid(world);
  const rotated = fixture();
  rotated.cameras[0].transform.rotation = [0, 0, 0, 3];
  invalid(rotated);
});

test('World IR rejects duplicate identities and missing camera references', () => {
  const duplicate = fixture();
  duplicate.cameras[0].id = 'actor_a';
  invalid(duplicate);
  const missing = fixture();
  missing.shots[0].cameraId = 'missing';
  invalid(missing);
});

test('World IR rejects shots and events outside scene duration', () => {
  const shot = fixture();
  shot.shots[0].endSeconds = 7;
  invalid(shot);
  const event = fixture();
  event.events[0].atSeconds = 7;
  invalid(event);
});

test('World IR rejects orphan relation/constraint and parent cycles', () => {
  const orphan = fixture();
  orphan.relations[0].toId = 'missing';
  invalid(orphan);
  const missingConstraint = fixture();
  missingConstraint.constraints[0].targetIds = ['missing'];
  invalid(missingConstraint);
  const cyclic = fixture();
  cyclic.relations = [
    { fromId: 'actor_a', toId: 'prop_window', kind: 'parent' },
    { fromId: 'prop_window', toId: 'actor_a', kind: 'parent' },
  ];
  invalid(cyclic);
});

test('World IR rejects executable payloads and undeclared provider secrets', () => {
  const injected = fixture() as WorldIR & { apiKey?: string };
  injected.apiKey = 'hidden';
  invalid(injected);
  const nested = fixture() as any;
  nested.entities[0].command = 'curl https://example.com';
  invalid(nested);
});

test('World IR does not treat model-generated proposals as approved facts', () => {
  const world = parseWorldIR(fixture());
  assert.equal(world.shots[1].authority, 'proposed');
  assert.equal(world.events[0].authority, 'proposed');
  assert.equal(world.entities[0].authority, 'approved');
});
