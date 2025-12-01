import SharedWorkspaceLocking from './shared-workspace-locking';
import BuildParameters from '../../../build-parameters';
import CloudRunner from '../../cloud-runner';
import Kubernetes from '../../providers/k8s';
import * as k8s from '@kubernetes/client-node';

describe('SharedWorkspaceLocking - K8s Provider', () => {
  let buildParameters: BuildParameters;
  let mockKubeClient: jest.Mocked<k8s.CoreV1Api>;

  beforeEach(() => {
    // Setup mock build parameters
    buildParameters = {
      providerStrategy: 'k8s',
      containerNamespace: 'test-namespace',
      cacheKey: 'test-cache-key',
      maxRetainedWorkspaces: 0, // Unlimited - simplified for testing
      buildGuid: 'test-build-guid-123',
    } as BuildParameters;

    // Mock Kubernetes client
    mockKubeClient = {
      readNamespacedConfigMap: jest.fn(),
      createNamespacedConfigMap: jest.fn(),
      replaceNamespacedConfigMap: jest.fn(),
      listNamespacedPersistentVolumeClaim: jest.fn(),
    } as any;

    // Create a provider that passes instanceof Kubernetes check
    const k8sProvider = Object.create(Kubernetes.prototype) as Kubernetes;
    Object.defineProperty(k8sProvider, 'kubeClient', {
      get: () => mockKubeClient,
      configurable: true,
    });
    Object.defineProperty(k8sProvider, 'namespace', {
      get: () => 'test-namespace',
      configurable: true,
    });

    // Set up CloudRunner mock
    CloudRunner.buildParameters = buildParameters;
    CloudRunner.Provider = k8sProvider;
    CloudRunner.lockedWorkspace = '';
  });

  describe('ConfigMap Management', () => {
    it('should use K8s provider when providerStrategy is k8s', () => {
      expect(CloudRunner.buildParameters.providerStrategy).toBe('k8s');
      expect(CloudRunner.Provider instanceof Kubernetes).toBe(true);
    });
  });

  describe('Workspace Root Paths', () => {
    it('should use k8s:// scheme for workspace bucket root', () => {
      const root = SharedWorkspaceLocking.workspaceBucketRoot;
      expect(root).toMatch(/^k8s:\/\//);
      expect(root).toContain('unity-builder-locks');
    });

    it('should use k8s:// scheme for workspace root', () => {
      const root = SharedWorkspaceLocking.workspaceRoot;
      expect(root).toMatch(/^k8s:\/\//);
      expect(root).toContain('unity-builder-locks');
      expect(root).toContain('/locks/');
    });
  });

  describe('Basic Operations', () => {
    it('should return empty array when no workspaces exist', async () => {
      mockKubeClient.readNamespacedConfigMap.mockResolvedValue({
        body: {
          metadata: { name: 'unity-builder-locks' },
          data: {},
        },
      } as any);

      const workspaces = await SharedWorkspaceLocking.GetAllWorkspaces(buildParameters);
      expect(workspaces).toEqual([]);
    });

    it('should return empty PVC list when useK8s is true but no PVCs exist', async () => {
      mockKubeClient.readNamespacedConfigMap.mockResolvedValue({
        body: {
          metadata: { name: 'unity-builder-locks' },
          data: {},
        },
      } as any);

      mockKubeClient.listNamespacedPersistentVolumeClaim.mockResolvedValue({
        body: {
          items: [],
        },
      } as any);

      const pvcStatus = await SharedWorkspaceLocking.GetAllPVCsWithLockStatus(buildParameters);
      expect(pvcStatus).toEqual([]);
    });
  });

  describe('Workspace Creation and Reuse with maxRetainedWorkspaces=3', () => {
    let configMapData: Record<string, string>;
    const cacheKey = 'test-cache-key';

    beforeEach(() => {
      // Set maxRetainedWorkspaces to 3
      buildParameters.maxRetainedWorkspaces = 3;
      CloudRunner.buildParameters = buildParameters;

      // Initialize empty configMap data
      configMapData = {};

      // Mock ConfigMap read to return current state - always returns latest configMapData
      mockKubeClient.readNamespacedConfigMap.mockImplementation(async () => {
        return {
          body: {
            metadata: { name: 'unity-builder-locks' },
            data: configMapData, // Return direct reference so updates are visible
          },
        } as any;
      });

      // Mock ConfigMap replace to update state
      mockKubeClient.replaceNamespacedConfigMap.mockImplementation(async (_name, _namespace, configMap) => {
        // Update the shared state
        configMapData = configMap.data || {};

        return {} as any;
      });

      // Mock ConfigMap create - creates empty configMap
      mockKubeClient.createNamespacedConfigMap.mockImplementation(async () => {
        return {} as any;
      });
    });

    /**
     * Helper to create a workspace entry in configMapData
     */
    function addWorkspaceToConfigMap(workspaceName: string, timestamp: number) {
      const key = `locks/${cacheKey}/${timestamp}_${workspaceName}_workspace`;
      configMapData[key] = timestamp.toString();
    }

    /**
     * Helper to add a lock entry in configMapData
     */
    function addLockToConfigMap(workspaceName: string, runId: string, timestamp: number) {
      const key = `locks/${cacheKey}/${timestamp}_${runId}_${workspaceName}_workspace_lock`;
      configMapData[key] = `${runId}_${timestamp}`;
    }

    /**
     * Helper to count workspaces in configMapData
     */
    function countWorkspaces(): number {
      return Object.keys(configMapData).filter((k) => k.endsWith('_workspace') && !k.endsWith('_workspace_lock'))
        .length;
    }

    /**
     * Helper to count locks in configMapData
     */
    function countLocks(): number {
      return Object.keys(configMapData).filter((k) => k.endsWith('_workspace_lock')).length;
    }

    describe('Creating workspaces before reaching limit', () => {
      it('should create first workspace successfully when none exist', async () => {
        const workspace = 'workspace-1';
        const result = await SharedWorkspaceLocking.CreateWorkspace(workspace, buildParameters);

        expect(result).toBe(true);
        expect(countWorkspaces()).toBe(1);
        expect(mockKubeClient.replaceNamespacedConfigMap).toHaveBeenCalled();

        // Verify the workspace key was created
        const keys = Object.keys(configMapData);
        expect(keys.some((k) => k.includes(workspace) && k.endsWith('_workspace'))).toBe(true);
      });

      it('should create second workspace successfully when only one exists', async () => {
        // Pre-create first workspace
        addWorkspaceToConfigMap('workspace-1', 1000);

        const workspace = 'workspace-2';
        const result = await SharedWorkspaceLocking.CreateWorkspace(workspace, buildParameters);

        expect(result).toBe(true);
        expect(countWorkspaces()).toBe(2);
      });

      it('should create third workspace successfully when two exist (still under limit)', async () => {
        // Pre-create two workspaces
        addWorkspaceToConfigMap('workspace-1', 1000);
        addWorkspaceToConfigMap('workspace-2', 2000);

        const workspace = 'workspace-3';
        const result = await SharedWorkspaceLocking.CreateWorkspace(workspace, buildParameters);

        expect(result).toBe(true);
        expect(countWorkspaces()).toBe(3);
      });

      it('should NOT create fourth workspace when three exist (at limit)', async () => {
        // Pre-create three workspaces (at limit)
        addWorkspaceToConfigMap('workspace-1', 1000);
        addWorkspaceToConfigMap('workspace-2', 2000);
        addWorkspaceToConfigMap('workspace-3', 3000);

        const workspace = 'workspace-4';
        const result = await SharedWorkspaceLocking.CreateWorkspace(workspace, buildParameters);

        // Should return false because it's above max and gets cleaned up
        expect(result).toBe(false);
      });
    });

    describe('Workspace locking flow', () => {
      it('should successfully lock an existing unlocked workspace', async () => {
        const workspace = 'workspace-1';
        const runId = 'run-abc-123';

        // Pre-create workspace
        addWorkspaceToConfigMap(workspace, 1000);

        const result = await SharedWorkspaceLocking.LockWorkspace(workspace, runId, buildParameters);

        expect(result).toBe(true);
        expect(CloudRunner.lockedWorkspace).toBe(workspace);
        expect(countLocks()).toBe(1);

        // Verify lock was created
        const lockKeys = Object.keys(configMapData).filter((k) => k.endsWith('_workspace_lock'));
        expect(lockKeys.length).toBe(1);
        expect(lockKeys[0]).toContain(runId);
        expect(lockKeys[0]).toContain(workspace);
      });

      it('should detect that workspace is locked', async () => {
        const workspace = 'workspace-1';
        const runId = 'run-abc-123';

        // Pre-create workspace and lock
        addWorkspaceToConfigMap(workspace, 1000);
        addLockToConfigMap(workspace, runId, 2000);

        const isLocked = await SharedWorkspaceLocking.IsWorkspaceLocked(workspace, buildParameters);

        expect(isLocked).toBe(true);
      });

      it('should detect that workspace is NOT locked when no lock exists', async () => {
        const workspace = 'workspace-1';

        // Pre-create workspace without lock
        addWorkspaceToConfigMap(workspace, 1000);

        const isLocked = await SharedWorkspaceLocking.IsWorkspaceLocked(workspace, buildParameters);

        expect(isLocked).toBe(false);
      });

      it('should release workspace lock successfully', async () => {
        const workspace = 'workspace-1';
        const runId = 'run-abc-123';

        // Pre-create workspace and lock
        addWorkspaceToConfigMap(workspace, 1000);
        addLockToConfigMap(workspace, runId, 2000);

        expect(countLocks()).toBe(1);

        const result = await SharedWorkspaceLocking.ReleaseWorkspace(workspace, runId, buildParameters);

        expect(result).toBe(true);
        expect(countLocks()).toBe(0);
      });
    });

    describe('Finding free workspaces', () => {
      it('should return empty array when no workspaces exist', async () => {
        const freeWorkspaces = await SharedWorkspaceLocking.GetFreeWorkspaces(buildParameters);

        expect(freeWorkspaces).toEqual([]);
      });

      it('should return unlocked workspace as free', async () => {
        // Pre-create one unlocked workspace
        addWorkspaceToConfigMap('workspace-1', 1000);

        const freeWorkspaces = await SharedWorkspaceLocking.GetFreeWorkspaces(buildParameters);

        expect(freeWorkspaces).toContain('workspace-1');
      });

      it('should NOT return locked workspace as free', async () => {
        // Pre-create one locked workspace
        addWorkspaceToConfigMap('workspace-1', 1000);
        addLockToConfigMap('workspace-1', 'run-xyz', 2000);

        const freeWorkspaces = await SharedWorkspaceLocking.GetFreeWorkspaces(buildParameters);

        expect(freeWorkspaces).not.toContain('workspace-1');
      });

      it('should return only unlocked workspaces when some are locked', async () => {
        // Pre-create three workspaces, two locked, one free
        addWorkspaceToConfigMap('workspace-1', 1000);
        addWorkspaceToConfigMap('workspace-2', 2000);
        addWorkspaceToConfigMap('workspace-3', 3000);

        addLockToConfigMap('workspace-1', 'run-1', 4000);
        addLockToConfigMap('workspace-3', 'run-3', 5000);

        const freeWorkspaces = await SharedWorkspaceLocking.GetFreeWorkspaces(buildParameters);

        expect(freeWorkspaces).toContain('workspace-2');
        expect(freeWorkspaces).not.toContain('workspace-1');
        expect(freeWorkspaces).not.toContain('workspace-3');
      });
    });

    describe('GetLockedWorkspace - full flow for workspace reuse', () => {
      it('should reuse existing free workspace instead of creating new one when at limit', async () => {
        const runId = 'new-run-123';

        // Pre-create three workspaces (at limit)
        // workspace-2 is free (unlocked), others are locked
        addWorkspaceToConfigMap('workspace-1', 1000);
        addWorkspaceToConfigMap('workspace-2', 2000);
        addWorkspaceToConfigMap('workspace-3', 3000);

        addLockToConfigMap('workspace-1', 'run-1', 4000);
        addLockToConfigMap('workspace-3', 'run-3', 5000);

        // Try to get a locked workspace
        const workspace = 'new-workspace';
        const result = await SharedWorkspaceLocking.GetLockedWorkspace(workspace, runId, buildParameters);

        expect(result).toBe(true);

        // Should have reused workspace-2 (the free one), not created new-workspace
        expect(CloudRunner.lockedWorkspace).toBe('workspace-2');

        // Verify lock was created for workspace-2
        const lockKeys = Object.keys(configMapData).filter((k) => k.endsWith('_workspace_lock'));
        const newLock = lockKeys.find((k) => k.includes(runId));
        expect(newLock).toBeDefined();
        expect(newLock).toContain('workspace-2');
      });

      it('should create new workspace when under limit and no free workspaces', async () => {
        const runId = 'new-run-456';

        // Pre-create one locked workspace (under limit of 3)
        addWorkspaceToConfigMap('workspace-1', 1000);
        addLockToConfigMap('workspace-1', 'run-1', 2000);

        const workspace = 'workspace-new';
        const result = await SharedWorkspaceLocking.GetLockedWorkspace(workspace, runId, buildParameters);

        expect(result).toBe(true);

        // Should have created and locked the new workspace
        expect(CloudRunner.lockedWorkspace).toBe(workspace);
        expect(countWorkspaces()).toBe(2);
      });

      it('should pick first available free workspace', async () => {
        const runId = 'run-picker';

        // Pre-create two free workspaces
        addWorkspaceToConfigMap('workspace-a', 1000);
        addWorkspaceToConfigMap('workspace-b', 2000);

        const workspace = 'new-workspace';
        const result = await SharedWorkspaceLocking.GetLockedWorkspace(workspace, runId, buildParameters);

        expect(result).toBe(true);

        // Should have picked one of the existing free workspaces
        expect(['workspace-a', 'workspace-b']).toContain(CloudRunner.lockedWorkspace);
      });
    });

    describe('Has workspace lock', () => {
      it('should return true when process has the only lock', async () => {
        const workspace = 'workspace-1';
        const runId = 'run-owner';

        addWorkspaceToConfigMap(workspace, 1000);
        addLockToConfigMap(workspace, runId, 2000);

        const hasLock = await SharedWorkspaceLocking.HasWorkspaceLock(workspace, runId, buildParameters);

        expect(hasLock).toBe(true);
      });

      it('should return false when a different process has the lock', async () => {
        const workspace = 'workspace-1';
        const otherRunId = 'run-other';
        const myRunId = 'run-mine';

        addWorkspaceToConfigMap(workspace, 1000);
        addLockToConfigMap(workspace, otherRunId, 2000);

        const hasLock = await SharedWorkspaceLocking.HasWorkspaceLock(workspace, myRunId, buildParameters);

        expect(hasLock).toBe(false);
      });

      it('should return true for earliest lock when multiple processes try to lock', async () => {
        const workspace = 'workspace-1';
        const earlyRunId = 'run-early';
        const lateRunId = 'run-late';

        addWorkspaceToConfigMap(workspace, 1000);

        // Early lock first
        addLockToConfigMap(workspace, earlyRunId, 2000);

        // Late lock second
        addLockToConfigMap(workspace, lateRunId, 3000);

        const earlyHasLock = await SharedWorkspaceLocking.HasWorkspaceLock(workspace, earlyRunId, buildParameters);
        const lateHasLock = await SharedWorkspaceLocking.HasWorkspaceLock(workspace, lateRunId, buildParameters);

        expect(earlyHasLock).toBe(true);
        expect(lateHasLock).toBe(false);
      });
    });

    describe('Workspace cleanup', () => {
      it('should remove workspace and its locks', async () => {
        const workspace = 'workspace-to-clean';
        const runId = 'run-clean';

        addWorkspaceToConfigMap(workspace, 1000);
        addLockToConfigMap(workspace, runId, 2000);

        // Add another workspace that should NOT be cleaned
        addWorkspaceToConfigMap('workspace-keep', 3000);

        expect(countWorkspaces()).toBe(2);
        expect(countLocks()).toBe(1);

        await SharedWorkspaceLocking.CleanupWorkspace(workspace, buildParameters);

        // workspace-to-clean should be removed
        const remainingWorkspaces = Object.keys(configMapData).filter(
          (k) => k.endsWith('_workspace') && !k.endsWith('_workspace_lock'),
        );
        expect(remainingWorkspaces.length).toBe(1);
        expect(remainingWorkspaces[0]).toContain('workspace-keep');

        // Lock should also be removed
        expect(countLocks()).toBe(0);
      });
    });

    describe('GetAllWorkspaces', () => {
      it('should return all workspace names', async () => {
        addWorkspaceToConfigMap('ws-alpha', 1000);
        addWorkspaceToConfigMap('ws-beta', 2000);
        addWorkspaceToConfigMap('ws-gamma', 3000);

        const workspaces = await SharedWorkspaceLocking.GetAllWorkspaces(buildParameters);

        expect(workspaces).toHaveLength(3);
        expect(workspaces).toContain('ws-alpha');
        expect(workspaces).toContain('ws-beta');
        expect(workspaces).toContain('ws-gamma');
      });

      it('should not include locks in workspace list', async () => {
        addWorkspaceToConfigMap('ws-1', 1000);
        addLockToConfigMap('ws-1', 'run-1', 2000);

        const workspaces = await SharedWorkspaceLocking.GetAllWorkspaces(buildParameters);

        expect(workspaces).toHaveLength(1);
        expect(workspaces).toContain('ws-1');
      });
    });

    describe('GetAllLocksForWorkspace', () => {
      it('should return all locks for a specific workspace', async () => {
        addWorkspaceToConfigMap('ws-1', 1000);
        addLockToConfigMap('ws-1', 'run-a', 2000);
        addLockToConfigMap('ws-1', 'run-b', 3000);

        // Lock for different workspace
        addWorkspaceToConfigMap('ws-2', 4000);
        addLockToConfigMap('ws-2', 'run-c', 5000);

        const locks = await SharedWorkspaceLocking.GetAllLocksForWorkspace('ws-1', buildParameters);

        expect(locks).toHaveLength(2);
        expect(locks.some((l) => l.includes('run-a'))).toBe(true);
        expect(locks.some((l) => l.includes('run-b'))).toBe(true);
        expect(locks.some((l) => l.includes('run-c'))).toBe(false);
      });

      it('should return empty array for workspace with no locks', async () => {
        addWorkspaceToConfigMap('ws-unlocked', 1000);

        const locks = await SharedWorkspaceLocking.GetAllLocksForWorkspace('ws-unlocked', buildParameters);

        expect(locks).toHaveLength(0);
      });
    });
  });

  describe('Edge cases with maxRetainedWorkspaces=0 (unlimited)', () => {
    let configMapData: Record<string, string>;

    beforeEach(() => {
      buildParameters.maxRetainedWorkspaces = 0;
      CloudRunner.buildParameters = buildParameters;

      // Initialize empty configMap data
      configMapData = {};

      // Mock ConfigMap read to return current state
      mockKubeClient.readNamespacedConfigMap.mockImplementation(async () => {
        return {
          body: {
            metadata: { name: 'unity-builder-locks' },
            data: configMapData,
          },
        } as any;
      });

      // Mock ConfigMap replace to update state
      mockKubeClient.replaceNamespacedConfigMap.mockImplementation(async (_name, _namespace, configMap) => {
        configMapData = configMap.data || {};

        return {} as any;
      });

      mockKubeClient.createNamespacedConfigMap.mockResolvedValue({} as any);
    });

    it('should always allow creating new workspaces when maxRetainedWorkspaces is 0', async () => {
      const result = await SharedWorkspaceLocking.CreateWorkspace('unlimited-ws', buildParameters);

      expect(result).toBe(true);
    });
  });
});
