import { describe, expect, it, beforeEach } from 'vitest';
import { BUILTIN_TYPE_IDS } from '@opendirector/core/types/provider-system';
import {
  registerTaskController,
  getTaskController,
  requireTaskController,
  type TaskController,
} from './task-controller-registry';
// Importing the controllers index auto-registers all built-in controllers.
import './controllers';

/** A minimal controller used for testing registration/lookup. */
const stubController: TaskController = {
  start: async () => 'stub-task-id',
  cancel: async () => true,
  resume: async () => true,
};

describe('TaskController registry', () => {
  beforeEach(() => {
    // Re-register built-ins to restore the default state after each test
    // (tests below add/remove custom controllers).
  });

  describe('built-in controllers', () => {
    const expectedTypeIds = [
      BUILTIN_TYPE_IDS.SEEDANCE,
      BUILTIN_TYPE_IDS.MINIMAX,
      BUILTIN_TYPE_IDS.OPENAI_IMAGE,
    ] as const;

    for (const typeId of expectedTypeIds) {
      it(`registers a controller for "${typeId}"`, () => {
        const controller = getTaskController(typeId);
        expect(controller).toBeDefined();
      });

      it(`controller for "${typeId}" implements the required surface (start/cancel/resume)`, () => {
        const controller = requireTaskController(typeId);
        expect(typeof controller.start).toBe('function');
        expect(typeof controller.cancel).toBe('function');
        expect(typeof controller.resume).toBe('function');
      });
    }

    it('Seedance controller implements optional polling methods (batchQuery/getTaskStatus/downloadResult/refreshActive)', () => {
      const controller = requireTaskController(BUILTIN_TYPE_IDS.SEEDANCE);
      expect(typeof controller.batchQuery).toBe('function');
      expect(typeof controller.getTaskStatus).toBe('function');
      expect(typeof controller.downloadResult).toBe('function');
      expect(typeof controller.refreshActive).toBe('function');
    });

    it('MiniMax controller does NOT implement polling methods (event-driven)', () => {
      const controller = requireTaskController(BUILTIN_TYPE_IDS.MINIMAX);
      expect(controller.batchQuery).toBeUndefined();
      expect(controller.getTaskStatus).toBeUndefined();
      expect(controller.downloadResult).toBeUndefined();
      expect(controller.refreshActive).toBeUndefined();
    });

    it('GPT Image controller does NOT implement polling methods (synchronous)', () => {
      const controller = requireTaskController(BUILTIN_TYPE_IDS.OPENAI_IMAGE);
      expect(controller.batchQuery).toBeUndefined();
      expect(controller.getTaskStatus).toBeUndefined();
      expect(controller.downloadResult).toBeUndefined();
      expect(controller.refreshActive).toBeUndefined();
    });
  });

  describe('requireTaskController', () => {
    it('throws for an unknown typeId (no silent fallback)', () => {
      expect(() => requireTaskController('nonexistent-type-id')).toThrow(
        /No TaskController registered for typeId "nonexistent-type-id"/,
      );
    });

    it('throws with the typeId in the error message', () => {
      try {
        requireTaskController('another-unknown');
      } catch (err) {
        expect(err instanceof Error).toBe(true);
        expect((err as Error).message).toContain('another-unknown');
      }
    });
  });

  describe('registerTaskController', () => {
    it('registers a custom controller that is retrievable via getTaskController', () => {
      registerTaskController('custom-test-type', stubController);
      expect(getTaskController('custom-test-type')).toBe(stubController);
      expect(requireTaskController('custom-test-type')).toBe(stubController);
    });

    it('overwrites an existing controller on re-registration', () => {
      const replacement: TaskController = {
        start: async () => 'replacement',
        cancel: async () => false,
        resume: async () => false,
      };
      registerTaskController('custom-test-type', stubController);
      registerTaskController('custom-test-type', replacement);
      expect(getTaskController('custom-test-type')).toBe(replacement);
    });
  });

  describe('getTaskController', () => {
    it('returns undefined for an unregistered typeId', () => {
      expect(getTaskController('never-registered')).toBeUndefined();
    });
  });
});
