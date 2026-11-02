import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardYaml, useStore } from '../src/renderer/src/store';
import type { Resource } from '../src/shared/protocol';

const pod = (uid: string): Resource => ({ apiVersion: 'v1', kind: 'Pod', metadata: { uid, name: uid, namespace: 'default' } });
const confirm = vi.fn<(message: string) => boolean>();
beforeEach(() => { vi.stubGlobal('window', { confirm }); confirm.mockReset(); useStore.setState({ selected: pod('a'), detailsDirty: false }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Details unsaved YAML guard', () => {
  it('closes and switches freely when there are no unsaved edits', () => {
    useStore.getState().select(pod('b'));
    useStore.getState().select(undefined);
    expect(useStore.getState().selected).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });
  it('keeps the selection and edits when discarding is declined', () => {
    useStore.getState().setDetailsDirty(true); confirm.mockReturnValue(false);
    useStore.getState().select(undefined);
    useStore.getState().select(pod('b'));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledWith(discardYaml);
    expect(useStore.getState()).toMatchObject({ selected: { metadata: { uid: 'a' } }, detailsDirty: true });
  });
  it('closes and clears the flag when discarding is confirmed', () => {
    useStore.getState().setDetailsDirty(true); confirm.mockReturnValue(true);
    useStore.getState().select(undefined);
    expect(useStore.getState()).toMatchObject({ selected: undefined, detailsDirty: false });
  });
  it('does not ask when the same resource is re-selected', () => {
    useStore.getState().setDetailsDirty(true);
    useStore.getState().select(pod('a'));
    expect(confirm).not.toHaveBeenCalled();
    expect(useStore.getState().detailsDirty).toBe(true);
  });
});
