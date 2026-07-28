import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { canonicalImportTarget, existingImportTargets, readLocalImportsFile } =
  await import(
    // @ts-expect-error This source module is compiled into the temporary native-test build.
    "../.test-build/src/terraform-config.mjs"
  );

test("TerraformConfig parses import targets structurally across tf files", () => {
  const root = mkdtempSync(join(tmpdir(), "terraform-config-targets-"));
  const generated = join(root, "imports.generated.tf");
  mkdirSync(join(root, "modules", "child"), { recursive: true });
  writeFileSync(
    join(root, "existing.tf"),
    `# import { to = aws_instance.comment }
resource "aws_instance" "unrelated" {}

import {
  id = "i-existing"
  to = aws_instance.web [ "blue" ] // canonical spacing
}
`,
  );
  writeFileSync(
    join(root, "modules", "child", "imports.tf"),
    `import {
  to = module.network.aws_vpc.main[0]
  id = "vpc-main"
}
`,
  );
  writeFileSync(
    generated,
    `import {
  to = aws_instance.generated
  id = "ignored"
}
`,
  );

  try {
    const targets = existingImportTargets(root, root, generated);
    assert.deepEqual(
      [...targets.keys()],
      ['aws_instance.web["blue"]', "module.network.aws_vpc.main[0]"],
    );
    assert.deepEqual(targets.get('aws_instance.web["blue"]')?.locations, [
      "existing.tf:6",
    ]);
    assert.equal(
      canonicalImportTarget('aws_instance.web["blue"]'),
      'aws_instance.web["blue"]',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TerraformConfig reports no collision for a distinct target", () => {
  const root = mkdtempSync(join(tmpdir(), "terraform-config-distinct-"));
  try {
    writeFileSync(
      join(root, "main.tf"),
      `import {
  to = aws_instance.existing
  id = "existing"
}
`,
    );
    const targets = existingImportTargets(
      root,
      root,
      join(root, "imports.generated.tf"),
    );
    assert.equal(targets.has("aws_instance.proposed"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TerraformConfig fails closed on malformed import blocks", () => {
  const root = mkdtempSync(join(tmpdir(), "terraform-config-invalid-"));
  try {
    writeFileSync(join(root, "invalid.tf"), 'import { id = "only"\n}\n');
    assert.throws(
      () =>
        existingImportTargets(root, root, join(root, "imports.generated.tf")),
      /invalid\.tf:1: import block has no to attribute/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TerraformConfig rejects a symlink root and a realpath escape", () => {
  const workspace = mkdtempSync(join(tmpdir(), "terraform-config-workspace-"));
  const outside = mkdtempSync(join(tmpdir(), "terraform-config-outside-"));
  mkdirSync(join(outside, "nested"));
  const directLink = join(workspace, "direct-root");
  const parentLink = join(workspace, "parent-link");
  symlinkSync(outside, directLink, "dir");
  symlinkSync(outside, parentLink, "dir");

  try {
    assert.throws(
      () =>
        existingImportTargets(
          workspace,
          directLink,
          join(workspace, "imports.generated.tf"),
        ),
      /terraform-root must not be a symbolic link/,
    );
    assert.throws(
      () =>
        existingImportTargets(
          workspace,
          join(parentLink, "nested"),
          join(workspace, "imports.generated.tf"),
        ),
      /terraform-root resolves outside GITHUB_WORKSPACE/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("TerraformConfig accepts normal nested roots and regular import files", () => {
  const workspace = mkdtempSync(join(tmpdir(), "terraform-config-nested-"));
  const root = join(workspace, "terraform", "environments", "production");
  const generated = join(root, "generated", "imports.generated.tf");
  mkdirSync(join(root, "generated"), { recursive: true });
  writeFileSync(join(root, "existing.tf"), 'resource "test_item" "main" {}\n');
  writeFileSync(generated, "# local generated imports\n");

  try {
    assert.equal(existingImportTargets(workspace, root, generated).size, 0);
    assert.equal(
      readLocalImportsFile(workspace, generated),
      "# local generated imports\n",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
