import CloudRunnerLogger from './cloud-runner-logger';
import BuildParameters from '../../../build-parameters';
import CloudRunner from '../../cloud-runner';
import Input from '../../../input';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3,
} from '@aws-sdk/client-s3';
import { AwsClientFactory } from '../../providers/aws/aws-client-factory';
import { promisify } from 'node:util';
import { exec as execCallback } from 'node:child_process';
import * as k8s from '@kubernetes/client-node';
import Kubernetes from '../../providers/k8s';

const exec = promisify(execCallback);
export class SharedWorkspaceLocking {
  private static _s3: S3;
  private static get s3(): S3 {
    if (!SharedWorkspaceLocking._s3) {
      // Use factory so LocalStack endpoint/path-style settings are honored
      SharedWorkspaceLocking._s3 = AwsClientFactory.getS3();
    }

    return SharedWorkspaceLocking._s3;
  }

  private static get useRclone() {
    return CloudRunner.buildParameters.storageProvider === 'rclone';
  }

  private static get useK8s() {
    return CloudRunner.buildParameters.providerStrategy === 'k8s';
  }

  private static get kubeClient(): k8s.CoreV1Api | undefined {
    if (CloudRunner.Provider instanceof Kubernetes) {
      return (CloudRunner.Provider as Kubernetes).kubeClient;
    }
  }

  private static get namespace(): string {
    if (CloudRunner.Provider instanceof Kubernetes) {
      return (CloudRunner.Provider as Kubernetes).namespace;
    }

    return 'default';
  }

  private static async rclone(command: string): Promise<string> {
    const { stdout } = await exec(`rclone ${command}`);

    return stdout.toString();
  }

  private static get configMapName() {
    return `unity-builder-locks`;
  }

  private static async getK8sConfigMap(): Promise<k8s.V1ConfigMap | undefined> {
    if (!SharedWorkspaceLocking.useK8s || !SharedWorkspaceLocking.kubeClient) {
      return;
    }

    try {
      const response = await SharedWorkspaceLocking.kubeClient.readNamespacedConfigMap(
        SharedWorkspaceLocking.configMapName,
        SharedWorkspaceLocking.namespace,
      );

      return response.body;
    } catch (error: any) {
      if (error.response?.statusCode === 404) {
        return;
      }

      throw error;
    }
  }

  private static async ensureK8sConfigMap(): Promise<void> {
    if (!SharedWorkspaceLocking.useK8s || !SharedWorkspaceLocking.kubeClient) {
      return;
    }

    const existing = await SharedWorkspaceLocking.getK8sConfigMap();
    if (!existing) {
      const configMap: k8s.V1ConfigMap = {
        apiVersion: 'v1',
        kind: 'ConfigMap',
        metadata: {
          name: SharedWorkspaceLocking.configMapName,
        },
        data: {},
      };
      await SharedWorkspaceLocking.kubeClient.createNamespacedConfigMap(SharedWorkspaceLocking.namespace, configMap);
    }
  }

  private static async updateK8sConfigMap(data: { [key: string]: string }): Promise<void> {
    if (!SharedWorkspaceLocking.useK8s || !SharedWorkspaceLocking.kubeClient) {
      return;
    }
    await SharedWorkspaceLocking.ensureK8sConfigMap();
    const configMap: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: SharedWorkspaceLocking.configMapName,
      },
      data,
    };
    await SharedWorkspaceLocking.kubeClient.replaceNamespacedConfigMap(
      SharedWorkspaceLocking.configMapName,
      SharedWorkspaceLocking.namespace,
      configMap,
    );
  }

  private static async listK8sPVCs(): Promise<string[]> {
    if (!SharedWorkspaceLocking.useK8s || !SharedWorkspaceLocking.kubeClient) {
      return [];
    }
    const response = await SharedWorkspaceLocking.kubeClient.listNamespacedPersistentVolumeClaim(
      SharedWorkspaceLocking.namespace,
    );

    return response.body.items.map((pvc) => pvc.metadata?.name || '').filter((name) => name !== '');
  }
  private static get bucket() {
    if (SharedWorkspaceLocking.useK8s) {
      return SharedWorkspaceLocking.configMapName;
    }

    return SharedWorkspaceLocking.useRclone
      ? CloudRunner.buildParameters.rcloneRemote
      : CloudRunner.buildParameters.awsStackName;
  }
  public static get workspaceBucketRoot() {
    if (SharedWorkspaceLocking.useK8s) {
      return `k8s://${SharedWorkspaceLocking.namespace}/${SharedWorkspaceLocking.configMapName}/`;
    }

    return SharedWorkspaceLocking.useRclone
      ? `${SharedWorkspaceLocking.bucket}/`
      : `s3://${SharedWorkspaceLocking.bucket}/`;
  }
  public static get workspaceRoot() {
    return `${SharedWorkspaceLocking.workspaceBucketRoot}locks/`;
  }
  private static get workspacePrefix() {
    return `locks/`;
  }
  private static async ensureBucketExists(): Promise<void> {
    const bucket = SharedWorkspaceLocking.bucket;
    if (SharedWorkspaceLocking.useK8s) {
      await SharedWorkspaceLocking.ensureK8sConfigMap();

      return;
    }
    if (SharedWorkspaceLocking.useRclone) {
      try {
        await SharedWorkspaceLocking.rclone(`lsf ${bucket}`);
      } catch {
        await SharedWorkspaceLocking.rclone(`mkdir ${bucket}`);
      }

      return;
    }
    try {
      await SharedWorkspaceLocking.s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      const region = Input.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
      const createParameters: any = { Bucket: bucket };
      if (region && region !== 'us-east-1') {
        createParameters.CreateBucketConfiguration = { LocationConstraint: region };
      }

      await SharedWorkspaceLocking.s3.send(new CreateBucketCommand(createParameters));
    }
  }
  private static async listObjects(prefix: string, bucket = SharedWorkspaceLocking.bucket): Promise<string[]> {
    await SharedWorkspaceLocking.ensureBucketExists();
    if (prefix !== '' && !prefix.endsWith('/')) {
      prefix += '/';
    }
    if (SharedWorkspaceLocking.useK8s) {
      const configMap = await SharedWorkspaceLocking.getK8sConfigMap();
      if (!configMap || !configMap.data) {
        return [];
      }
      const entries: string[] = [];

      // Keys in ConfigMap represent the full path, filter by prefix
      for (const key of Object.keys(configMap.data)) {
        if (key.startsWith(prefix)) {
          const relative = key.slice(prefix.length);
          if (relative) {
            // Extract immediate children only
            const slashIndex = relative.indexOf('/');
            if (slashIndex === -1) {
              // It's a file
              entries.push(relative);
            } else {
              // It's a directory
              const directory = relative.slice(0, slashIndex + 1);
              if (!entries.includes(directory)) {
                entries.push(directory);
              }
            }
          }
        }
      }

      return entries;
    }

    if (SharedWorkspaceLocking.useRclone) {
      const path = `${bucket}/${prefix}`;
      try {
        const output = await SharedWorkspaceLocking.rclone(`lsjson ${path}`);
        const json = JSON.parse(output) as { Name: string; IsDir: boolean }[];

        return json.map((entry) => (entry.IsDir ? `${entry.Name}/` : entry.Name));
      } catch {
        return [];
      }
    }

    const result = await SharedWorkspaceLocking.s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/' }),
    );
    const entries: string[] = [];
    for (const p of result.CommonPrefixes || []) {
      if (p.Prefix) entries.push(p.Prefix.slice(prefix.length));
    }
    for (const c of result.Contents || []) {
      if (c.Key && c.Key !== prefix) entries.push(c.Key.slice(prefix.length));
    }

    return entries;
  }
  public static async GetAllWorkspaces(buildParametersContext: BuildParameters): Promise<string[]> {
    if (!(await SharedWorkspaceLocking.DoesCacheKeyTopLevelExist(buildParametersContext))) {
      return [];
    }

    return (
      await SharedWorkspaceLocking.listObjects(
        `${SharedWorkspaceLocking.workspacePrefix}${buildParametersContext.cacheKey}/`,
      )
    )
      .map((x) => x.replace(`/`, ``))
      .filter((x) => x.endsWith(`_workspace`))
      .map((x) => x.split(`_`)[1]);
  }

  public static async GetAllPVCsWithLockStatus(
    buildParametersContext: BuildParameters,
  ): Promise<Array<{ name: string; isLocked: boolean; lockedBy?: string }>> {
    if (!SharedWorkspaceLocking.useK8s) {
      return [];
    }

    const allPVCs = await SharedWorkspaceLocking.listK8sPVCs();
    const workspaces = await SharedWorkspaceLocking.GetAllWorkspaces(buildParametersContext);

    const result: Array<{ name: string; isLocked: boolean; lockedBy?: string }> = [];

    for (const pvcName of allPVCs) {
      // Check if this PVC matches any workspace pattern
      const matchingWorkspace = workspaces.find((ws) => pvcName.includes(ws));

      if (matchingWorkspace) {
        const isLocked = await SharedWorkspaceLocking.IsWorkspaceLocked(matchingWorkspace, buildParametersContext);
        let lockedBy: string | undefined;

        if (isLocked) {
          const locks = await SharedWorkspaceLocking.GetAllLocksForWorkspace(matchingWorkspace, buildParametersContext);
          if (locks.length > 0) {
            // Extract runId from lock name (format: timestamp_runId_workspace_lock)
            const lockParts = locks[0].split('_');
            if (lockParts.length >= 2) {
              lockedBy = lockParts[1];
            }
          }
        }

        result.push({
          name: pvcName,
          isLocked,
          lockedBy,
        });
      } else {
        // PVC doesn't match any known workspace
        result.push({
          name: pvcName,
          isLocked: false,
        });
      }
    }

    return result;
  }
  public static async DoesCacheKeyTopLevelExist(buildParametersContext: BuildParameters) {
    try {
      const rootLines = await SharedWorkspaceLocking.listObjects('');
      const lockFolderExists = rootLines.map((x) => x.replace(`/`, ``)).includes(`locks`);

      if (lockFolderExists) {
        const lines = await SharedWorkspaceLocking.listObjects(SharedWorkspaceLocking.workspacePrefix);

        return lines.map((x) => x.replace(`/`, ``)).includes(buildParametersContext.cacheKey);
      } else {
        return false;
      }
    } catch {
      return false;
    }
  }

  public static NewWorkspaceName() {
    return `${CloudRunner.retainedWorkspacePrefix}-${CloudRunner.buildParameters.buildGuid}`;
  }
  public static async GetAllLocksForWorkspace(
    workspace: string,
    buildParametersContext: BuildParameters,
  ): Promise<string[]> {
    if (!(await SharedWorkspaceLocking.DoesWorkspaceExist(workspace, buildParametersContext))) {
      return [];
    }

    return (
      await SharedWorkspaceLocking.listObjects(
        `${SharedWorkspaceLocking.workspacePrefix}${buildParametersContext.cacheKey}/`,
      )
    )
      .map((x) => x.replace(`/`, ``))
      .filter((x) => x.includes(workspace) && x.endsWith(`_lock`));
  }
  public static async GetLockedWorkspace(workspace: string, runId: string, buildParametersContext: BuildParameters) {
    if (buildParametersContext.maxRetainedWorkspaces === 0) {
      return false;
    }

    if (await SharedWorkspaceLocking.DoesCacheKeyTopLevelExist(buildParametersContext)) {
      const workspaces = await SharedWorkspaceLocking.GetFreeWorkspaces(buildParametersContext);
      CloudRunnerLogger.log(`run agent ${runId} is trying to access a workspace, free: ${JSON.stringify(workspaces)}`);
      for (const element of workspaces) {
        const lockResult = await SharedWorkspaceLocking.LockWorkspace(element, runId, buildParametersContext);
        CloudRunnerLogger.log(
          `run agent: ${runId} try lock workspace: ${element} locking attempt result: ${lockResult}`,
        );

        if (lockResult) {
          return true;
        }
      }
    }

    if (await SharedWorkspaceLocking.DoesWorkspaceExist(workspace, buildParametersContext)) {
      workspace = SharedWorkspaceLocking.NewWorkspaceName();
      CloudRunner.lockedWorkspace = workspace;
    }

    const createResult = await SharedWorkspaceLocking.CreateWorkspace(workspace, buildParametersContext);
    const lockResult = await SharedWorkspaceLocking.LockWorkspace(workspace, runId, buildParametersContext);
    CloudRunnerLogger.log(
      `run agent ${runId} didn't find a free workspace so created: ${workspace} createWorkspaceSuccess: ${createResult} Lock:${lockResult}`,
    );

    return createResult && lockResult;
  }

  public static async DoesWorkspaceExist(workspace: string, buildParametersContext: BuildParameters) {
    return (
      (await SharedWorkspaceLocking.GetAllWorkspaces(buildParametersContext)).filter((x) => x.includes(workspace))
        .length > 0
    );
  }
  public static async HasWorkspaceLock(
    workspace: string,
    runId: string,
    buildParametersContext: BuildParameters,
  ): Promise<boolean> {
    const locks = (await SharedWorkspaceLocking.GetAllLocksForWorkspace(workspace, buildParametersContext))
      .map((x) => {
        return {
          name: x,
          timestamp: Number(x.split(`_`)[0]),
        };
      })
      .sort((x) => x.timestamp);
    const lockMatches = locks.filter((x) => x.name.includes(runId));
    const includesRunLock = lockMatches.length > 0 && locks.indexOf(lockMatches[0]) === 0;
    CloudRunnerLogger.log(
      `Checking has workspace lock, runId: ${runId}, workspace: ${workspace}, success: ${includesRunLock} \n- Num of locks created by Run Agent: ${
        lockMatches.length
      } Num of Locks: ${locks.length}, Time ordered index for Run Agent: ${locks.indexOf(lockMatches[0])} \n \n`,
    );

    return includesRunLock;
  }

  public static async GetFreeWorkspaces(buildParametersContext: BuildParameters): Promise<string[]> {
    const result: string[] = [];
    const workspaces = await SharedWorkspaceLocking.GetAllWorkspaces(buildParametersContext);
    for (const element of workspaces) {
      const isLocked = await SharedWorkspaceLocking.IsWorkspaceLocked(element, buildParametersContext);
      const isBelowMax = await SharedWorkspaceLocking.IsWorkspaceBelowMax(element, buildParametersContext);
      CloudRunnerLogger.log(`workspace ${element} locked:${isLocked} below max:${isBelowMax}`);
      if (!isLocked && isBelowMax) {
        result.push(element);
      }
    }

    return result;
  }

  public static async IsWorkspaceBelowMax(
    workspace: string,
    buildParametersContext: BuildParameters,
  ): Promise<boolean> {
    const workspaces = await SharedWorkspaceLocking.GetAllWorkspaces(buildParametersContext);
    if (workspace === ``) {
      return (
        workspaces.length < buildParametersContext.maxRetainedWorkspaces ||
        buildParametersContext.maxRetainedWorkspaces === 0
      );
    }
    const ordered: any[] = [];
    for (const ws of workspaces) {
      ordered.push({
        name: ws,
        timestamp: await SharedWorkspaceLocking.GetWorkspaceTimestamp(ws, buildParametersContext),
      });
    }
    ordered.sort((x) => x.timestamp);
    const matches = ordered.filter((x) => x.name.includes(workspace));
    const isWorkspaceBelowMax =
      matches.length > 0 &&
      (ordered.indexOf(matches[0]) < buildParametersContext.maxRetainedWorkspaces ||
        buildParametersContext.maxRetainedWorkspaces === 0);

    return isWorkspaceBelowMax;
  }

  public static async GetWorkspaceTimestamp(
    workspace: string,
    buildParametersContext: BuildParameters,
  ): Promise<Number> {
    if (workspace.split(`_`).length > 0) {
      return Number(workspace.split(`_`)[1]);
    }

    if (!(await SharedWorkspaceLocking.DoesWorkspaceExist(workspace, buildParametersContext))) {
      throw new Error("Workspace doesn't exist, can't call get all locks");
    }

    return (
      await SharedWorkspaceLocking.listObjects(
        `${SharedWorkspaceLocking.workspacePrefix}${buildParametersContext.cacheKey}/`,
      )
    )
      .map((x) => x.replace(`/`, ``))
      .filter((x) => x.includes(workspace) && x.endsWith(`_workspace`))
      .map((x) => Number(x))[0];
  }

  public static async IsWorkspaceLocked(workspace: string, buildParametersContext: BuildParameters): Promise<boolean> {
    if (!(await SharedWorkspaceLocking.DoesWorkspaceExist(workspace, buildParametersContext))) {
      throw new Error(`workspace doesn't exist ${workspace}`);
    }
    const files = await SharedWorkspaceLocking.listObjects(
      `${SharedWorkspaceLocking.workspacePrefix}${buildParametersContext.cacheKey}/`,
    );

    const lockFilesExist =
      files.filter((x) => {
        return x.includes(workspace) && x.endsWith(`_lock`);
      }).length > 0;

    return lockFilesExist;
  }

  public static async CreateWorkspace(workspace: string, buildParametersContext: BuildParameters): Promise<boolean> {
    if (await SharedWorkspaceLocking.DoesWorkspaceExist(workspace, buildParametersContext)) {
      throw new Error(`${workspace} already exists`);
    }
    const timestamp = Date.now();
    const key = `${SharedWorkspaceLocking.workspacePrefix}${buildParametersContext.cacheKey}/${timestamp}_${workspace}_workspace`;
    await SharedWorkspaceLocking.ensureBucketExists();
    if (SharedWorkspaceLocking.useK8s) {
      const configMap = await SharedWorkspaceLocking.getK8sConfigMap();
      const data = configMap?.data || {};
      data[key] = timestamp.toString();
      await SharedWorkspaceLocking.updateK8sConfigMap(data);
    } else if (SharedWorkspaceLocking.useRclone) {
      await SharedWorkspaceLocking.rclone(`touch ${SharedWorkspaceLocking.bucket}/${key}`);
    } else {
      await SharedWorkspaceLocking.s3.send(
        new PutObjectCommand({ Bucket: SharedWorkspaceLocking.bucket, Key: key, Body: new Uint8Array(0) }),
      );
    }

    const workspaces = await SharedWorkspaceLocking.GetAllWorkspaces(buildParametersContext);

    CloudRunnerLogger.log(`All workspaces ${workspaces}`);
    if (!(await SharedWorkspaceLocking.IsWorkspaceBelowMax(workspace, buildParametersContext))) {
      CloudRunnerLogger.log(`Workspace is above max ${workspaces} ${buildParametersContext.maxRetainedWorkspaces}`);
      await SharedWorkspaceLocking.CleanupWorkspace(workspace, buildParametersContext);

      return false;
    }

    return true;
  }

  public static async LockWorkspace(
    workspace: string,
    runId: string,
    buildParametersContext: BuildParameters,
  ): Promise<boolean> {
    const existingWorkspace = workspace.endsWith(`_workspace`);
    const ending = existingWorkspace ? workspace : `${workspace}_workspace`;
    const key = `${SharedWorkspaceLocking.workspacePrefix}${
      buildParametersContext.cacheKey
    }/${Date.now()}_${runId}_${ending}_lock`;
    await SharedWorkspaceLocking.ensureBucketExists();
    if (SharedWorkspaceLocking.useK8s) {
      const configMap = await SharedWorkspaceLocking.getK8sConfigMap();
      const data = configMap?.data || {};
      data[key] = `${runId}_${Date.now()}`;
      await SharedWorkspaceLocking.updateK8sConfigMap(data);
    } else if (SharedWorkspaceLocking.useRclone) {
      await SharedWorkspaceLocking.rclone(`touch ${SharedWorkspaceLocking.bucket}/${key}`);
    } else {
      await SharedWorkspaceLocking.s3.send(
        new PutObjectCommand({ Bucket: SharedWorkspaceLocking.bucket, Key: key, Body: new Uint8Array(0) }),
      );
    }

    const hasLock = await SharedWorkspaceLocking.HasWorkspaceLock(workspace, runId, buildParametersContext);

    if (hasLock) {
      CloudRunner.lockedWorkspace = workspace;
    } else {
      if (SharedWorkspaceLocking.useK8s) {
        const configMap = await SharedWorkspaceLocking.getK8sConfigMap();
        const data = configMap?.data || {};
        delete data[key];
        await SharedWorkspaceLocking.updateK8sConfigMap(data);
      } else if (SharedWorkspaceLocking.useRclone) {
        await SharedWorkspaceLocking.rclone(`delete ${SharedWorkspaceLocking.bucket}/${key}`);
      } else {
        await SharedWorkspaceLocking.s3.send(
          new DeleteObjectCommand({ Bucket: SharedWorkspaceLocking.bucket, Key: key }),
        );
      }
    }

    return hasLock;
  }

  public static async ReleaseWorkspace(
    workspace: string,
    runId: string,
    buildParametersContext: BuildParameters,
  ): Promise<boolean> {
    await SharedWorkspaceLocking.ensureBucketExists();
    const files = await SharedWorkspaceLocking.GetAllLocksForWorkspace(workspace, buildParametersContext);
    const file = files.find((x) => x.includes(workspace) && x.endsWith(`_lock`) && x.includes(runId));
    CloudRunnerLogger.log(`All Locks ${files} ${workspace} ${runId}`);
    CloudRunnerLogger.log(`Deleting lock ${workspace}/${file}`);
    CloudRunnerLogger.log(`rm ${SharedWorkspaceLocking.workspaceRoot}${buildParametersContext.cacheKey}/${file}`);
    if (file) {
      if (SharedWorkspaceLocking.useK8s) {
        const configMap = await SharedWorkspaceLocking.getK8sConfigMap();
        const data = configMap?.data || {};
        const key = `${SharedWorkspaceLocking.workspacePrefix}${buildParametersContext.cacheKey}/${file}`;
        delete data[key];
        await SharedWorkspaceLocking.updateK8sConfigMap(data);
      } else if (SharedWorkspaceLocking.useRclone) {
        await SharedWorkspaceLocking.rclone(
          `delete ${SharedWorkspaceLocking.bucket}/${SharedWorkspaceLocking.workspacePrefix}${buildParametersContext.cacheKey}/${file}`,
        );
      } else {
        await SharedWorkspaceLocking.s3.send(
          new DeleteObjectCommand({
            Bucket: SharedWorkspaceLocking.bucket,
            Key: `${SharedWorkspaceLocking.workspacePrefix}${buildParametersContext.cacheKey}/${file}`,
          }),
        );
      }
    }

    return !(await SharedWorkspaceLocking.HasWorkspaceLock(workspace, runId, buildParametersContext));
  }

  public static async CleanupWorkspace(workspace: string, buildParametersContext: BuildParameters) {
    const prefix = `${SharedWorkspaceLocking.workspacePrefix}${buildParametersContext.cacheKey}/`;
    const files = await SharedWorkspaceLocking.listObjects(prefix);
    for (const file of files.filter((x) => x.includes(`_${workspace}_`))) {
      if (SharedWorkspaceLocking.useK8s) {
        const configMap = await SharedWorkspaceLocking.getK8sConfigMap();
        const data = configMap?.data || {};
        delete data[`${prefix}${file}`];
        await SharedWorkspaceLocking.updateK8sConfigMap(data);
      } else if (SharedWorkspaceLocking.useRclone) {
        await SharedWorkspaceLocking.rclone(`delete ${SharedWorkspaceLocking.bucket}/${prefix}${file}`);
      } else {
        await SharedWorkspaceLocking.s3.send(
          new DeleteObjectCommand({ Bucket: SharedWorkspaceLocking.bucket, Key: `${prefix}${file}` }),
        );
      }
    }
  }

  public static async ReadLines(command: string): Promise<string[]> {
    const path = command.replace('aws s3 ls', '').replace('rclone lsf', '').trim();
    const withoutScheme = path.replace('s3://', '');
    const [bucket, ...rest] = withoutScheme.split('/');
    const prefix = rest.join('/');

    return SharedWorkspaceLocking.listObjects(prefix, bucket);
  }
}

export default SharedWorkspaceLocking;
