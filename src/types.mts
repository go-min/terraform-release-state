import type * as github from "@actions/github";

export type Octokit = ReturnType<typeof github.getOctokit>;
export type Release = Awaited<
  ReturnType<Octokit["rest"]["repos"]["getReleaseByTag"]>
>["data"];
export type Asset = Release["assets"][number];

export type RemoteStateMarker = {
  id: number;
  name: string;
  digest: string;
  size: number;
  updatedAt: string;
};

export type DecodedMarker = "absent" | RemoteStateMarker;

export type RepositoryTarget = {
  owner: string;
  repo: string;
};

export type EncryptionMode = "none" | "age";

export type EncryptionConfig = {
  mode: EncryptionMode;
  recipients: string[];
  identities: string[];
};

export type ActionConfig = {
  operation: "restore" | "save" | "reset" | "import";
  token: string;
  target: RepositoryTarget;
  prTarget: RepositoryTarget;
  tag: string;
  assetName: string;
  workspace: string;
  statePath: string;
  bootstrap: boolean;
  expectedMarker: string;
  backupRetention: number;
  sourceCommit: string;
  workflowRunId: string;
  resetConfirmation: string;
  importsPath: string;
  terraformRoot: string;
  createPr: boolean;
  prBase: string;
  prBranch: string;
  prTitle: string;
  encryption: EncryptionConfig;
};

export type StateManagerContext = {
  octokit: Octokit;
  config: ActionConfig;
};
