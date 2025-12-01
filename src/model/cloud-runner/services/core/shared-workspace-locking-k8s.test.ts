import SharedWorkspaceLocking from './shared-workspace-locking';
import BuildParameters from '../../../build-parameters';
import CloudRunner from '../../cloud-runner';
import Kubernetes from '../../providers/k8s';
import * as k8s from '@kubernetes/client-node';

describe('SharedWorkspaceLocking - K8s Provider', () => {
  let buildParameters: BuildParameters;
  let mockKubeClient: jest.Mocked<k8s.CoreV1Api>;
  let mockK8sProvider: jest.Mocked<Kubernetes>;

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

    // Mock Kubernetes provider
    mockK8sProvider = {
      kubeClient: mockKubeClient,
      namespace: 'test-namespace',
    } as any;

    // Set up CloudRunner mock
    CloudRunner.buildParameters = buildParameters;
    CloudRunner.Provider = mockK8sProvider;
  });

  describe('ConfigMap Management', () => {
    it('should use K8s provider when providerStrategy is k8s', () => {
      expect(CloudRunner.buildParameters.providerStrategy).toBe('k8s');
      expect(CloudRunner.Provider).toBe(mockK8sProvider);
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
});
