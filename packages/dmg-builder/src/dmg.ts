import { DmgOptions, Target } from "app-builder-lib"
import { findIdentity, isSignAllowed } from "app-builder-lib/out/codeSign/macCodeSign"
import { MacPackager } from "app-builder-lib/out/macPackager"
import { createBlockmap } from "app-builder-lib/out/targets/differentialUpdateInfoBuilder"
import { executeAppBuilderAsJson } from "app-builder-lib/out/util/appBuilder"
import { Arch, AsyncTaskManager, copyDir, copyFile, exec, exists, getArchSuffix, InvalidConfigurationError, isEmptyOrSpaces, log, statOrNull } from "builder-util"
import { CancellationToken, Nullish } from "builder-util-runtime"
import { sanitizeFileName } from "builder-util/out/filename"
import { stat } from "fs-extra"
import { release as getOsRelease } from "os"
import * as path from "path"
import { TmpDir } from "temp-file"
import { addLicenseToDmg } from "./dmgLicense"
import { attachAndExecute, computeBackground, detach, getDmgVendorPath } from "./dmgUtil"
import { hdiUtil, hdiutilTransientExitCodes } from "./hdiuil"

export class DmgTarget extends Target {
  readonly options: DmgOptions = this.packager.config.dmg || Object.create(null)

  isAsyncSupported = false

  constructor(
    private readonly packager: MacPackager,
    readonly outDir: string
  ) {
    super("dmg")
  }

  async build(appPath: string, arch: Arch) {
    const packager = this.packager
    // tslint:disable-next-line:no-invalid-template-strings
    const artifactName = packager.expandArtifactNamePattern(
      this.options,
      "dmg",
      arch,
      "${productName}-" + (packager.platformSpecificBuildOptions.bundleShortVersion || "${version}") + "-${arch}.${ext}",
      true,
      packager.platformSpecificBuildOptions.defaultArch
    )
    const artifactPath = path.join(this.outDir, artifactName)
    await packager.info.emitArtifactBuildStarted({
      targetPresentableName: "DMG",
      file: artifactPath,
      arch,
    })

    const volumeName = sanitizeFileName(this.computeVolumeName(arch, this.options.title))

    const tempDmg = await createStageDmg(await packager.getTempFile(".dmg"), appPath, volumeName)

    const specification = await this.computeDmgOptions()
    // https://github.com/electron-userland/electron-builder/issues/2115
    const backgroundFile = specification.background == null ? null : await transformBackgroundFileIfNeed(specification.background, packager.info.tempDirManager)
    const finalSize = await computeAssetSize(packager.info.cancellationToken, tempDmg, specification, backgroundFile)
    const expandingFinalSize = Math.ceil(finalSize * 0.1 + finalSize)
    await hdiUtil(["resize", "-size", expandingFinalSize.toString(), tempDmg])

    const volumePath = path.join("/Volumes", volumeName)
    if (await exists(volumePath)) {
      log.debug({ volumePath }, "unmounting previous disk image")
      await detach(volumePath)
    }

    if (!(await attachAndExecute(tempDmg, true, () => customizeDmg(volumePath, specification, packager, backgroundFile)))) {
      return
    }

    // dmg file must not exist otherwise hdiutil failed (https://github.com/electron-userland/electron-builder/issues/1308#issuecomment-282847594), so, -ov must be specified
    const args = ["convert", tempDmg, "-ov", "-format", specification.format!, "-o", artifactPath]
    if (specification.format === "UDZO") {
      args.push("-imagekey", `zlib-level=${process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL || "9"}`)
    }
    await hdiUtil(addLogLevel(args))
    if (this.options.internetEnabled && parseInt(getOsRelease().split(".")[0], 10) < 19) {
      await hdiUtil(addLogLevel(["internet-enable"]).concat(artifactPath))
    }

    const licenseData = await addLicenseToDmg(packager, artifactPath)
    if (packager.packagerOptions.effectiveOptionComputed != null) {
      await packager.packagerOptions.effectiveOptionComputed({ licenseData })
    }

    if (this.options.sign === true) {
      await this.signDmg(artifactPath)
    }

    const safeArtifactName = packager.computeSafeArtifactName(artifactName, "dmg")
    const updateInfo = this.options.writeUpdateInfo === false ? null : await createBlockmap(artifactPath, this, packager, safeArtifactName)
    await packager.info.emitArtifactBuildCompleted({
      file: artifactPath,
      safeArtifactName,
      target: this,
      arch,
      packager,
      isWriteUpdateInfo: updateInfo != null,
      updateInfo,
    })
  }

  private async signDmg(artifactPath: string) {
    if (!isSignAllowed(false)) {
      return
    }

    const packager = this.packager
    const qualifier = packager.platformSpecificBuildOptions.identity
    // explicitly disabled if set to null
    if (qualifier === null) {
      // macPackager already somehow handle this situation, so, here just return
      return
    }

    const keychainFile = (await packager.codeSigningInfo.value).keychainFile
    const certificateType = "Developer ID Application"
    let identity = await findIdentity(certificateType, qualifier, keychainFile)
    if (identity == null) {
      identity = await findIdentity("Mac Developer", qualifier, keychainFile)
      if (identity == null) {
        return
      }
    }

    const args = ["--sign", identity.hash!]
    if (keychainFile != null) {
      args.push("--keychain", keychainFile)
    }
    args.push(artifactPath)
    await exec("codesign", args)
  }

  computeVolumeName(arch: Arch, custom?: string | null): string {
    const appInfo = this.packager.appInfo
    const shortVersion = this.packager.platformSpecificBuildOptions.bundleShortVersion || appInfo.version
    const archString = getArchSuffix(arch, this.packager.platformSpecificBuildOptions.defaultArch)

    if (custom == null) {
      return `${appInfo.productFilename} ${shortVersion}${archString}`
    }

    return custom
      .replace(/\${arch}/g, archString)
      .replace(/\${shortVersion}/g, shortVersion)
      .replace(/\${version}/g, appInfo.version)
      .replace(/\${name}/g, appInfo.name)
      .replace(/\${productName}/g, appInfo.productName)
  }

  // public to test
  async computeDmgOptions(): Promise<DmgOptions> {
    const packager = this.packager
    const specification: DmgOptions = { ...this.options }
    if (specification.icon == null && specification.icon !== null) {
      specification.icon = await packager.getIconPath()
    }

    if (specification.icon != null && isEmptyOrSpaces(specification.icon)) {
      throw new InvalidConfigurationError("dmg.icon cannot be specified as empty string")
    }

    const background = specification.background
    if (specification.backgroundColor != null) {
      if (background != null) {
        throw new InvalidConfigurationError("Both dmg.backgroundColor and dmg.background are specified — please set the only one")
      }
    } else if (background == null) {
      specification.background = await computeBackground(packager)
    } else {
      specification.background = path.resolve(packager.info.projectDir, background)
    }

    if (specification.format == null) {
      if (process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL != null) {
        ;(specification as any).format = "UDZO"
      } else if (packager.compression === "store") {
        specification.format = "UDRO"
      } else {
        specification.format = packager.compression === "maximum" ? "UDBZ" : "UDZO"
      }
    }

    if (specification.contents == null) {
      specification.contents = [
        {
          x: 130,
          y: 220,
        },
        {
          x: 410,
          y: 220,
          type: "link",
          path: "/Applications",
        },
      ]
    }
    return specification
  }
}

async function createStageDmg(tempDmg: string, appPath: string, volumeName: string) {
  const createArgs = ["create", "-srcfolder", appPath, "-volname", volumeName, "-anyowners", "-nospotlight", "-format", "UDRW"]
  const imageArgs = addLogLevel(createArgs)
  if (log.isDebugEnabled) {
    imageArgs.push("-debug")
  }

  imageArgs.push("-fs", "APFS")
  imageArgs.push(tempDmg)
  await hdiUtil(imageArgs).catch(async e => {
    if (hdiutilTransientExitCodes.has(e.code)) {
      // Delay then create, then retry with verbose output
      await new Promise(resolve => setTimeout(resolve, 3000))
      return hdiUtil(addLogLevel(createArgs, true))
    }
    throw e
  })
  return tempDmg
}

function addLogLevel(args: Array<string>, isVerbose = process.env.DEBUG_DMG === "true"): Array<string> {
  args.push(isVerbose ? "-verbose" : "-quiet")
  return args
}

async function computeAssetSize(cancellationToken: CancellationToken, dmgFile: string, specification: DmgOptions, backgroundFile: string | Nullish) {
  const asyncTaskManager = new AsyncTaskManager(cancellationToken)
  asyncTaskManager.addTask(stat(dmgFile))

  if (specification.icon != null) {
    asyncTaskManager.addTask(statOrNull(specification.icon))
  }

  if (backgroundFile != null) {
    asyncTaskManager.addTask(stat(backgroundFile))
  }

  let result = 32 * 1024
  for (const stat of await asyncTaskManager.awaitTasks()) {
    if (stat != null) {
      result += stat.size
    }
  }
  return result
}

async function customizeDmg(volumePath: string, specification: DmgOptions, packager: MacPackager, backgroundFile: string | Nullish) {
  const window = specification.window
  const isValidIconTextSize = !!specification.iconTextSize && specification.iconTextSize >= 10 && specification.iconTextSize <= 16
  const iconTextSize = isValidIconTextSize ? specification.iconTextSize : 12
  const env: any = {
    ...process.env,
    volumePath,
    appFileName: `${packager.appInfo.productFilename}.app`,
    iconSize: specification.iconSize || 80,
    iconTextSize,

    PYTHONIOENCODING: "utf8",
  }

  if (specification.backgroundColor != null || specification.background == null) {
    env.backgroundColor = specification.backgroundColor || "#ffffff"

    if (window != null) {
      env.windowX = (window.x == null ? 100 : window.x).toString()
      env.windowY = (window.y == null ? 400 : window.y).toString()
      env.windowWidth = (window.width || 540).toString()
      env.windowHeight = (window.height || 380).toString()
    }
  } else {
    delete env.backgroundColor
  }

  const args = ["dmg", "--volume", volumePath]
  if (specification.icon != null) {
    args.push("--icon", (await packager.getResource(specification.icon))!)
  }
  if (backgroundFile != null) {
    args.push("--background", backgroundFile)
  }

  const data: any = await executeAppBuilderAsJson(args)
  if (data.backgroundWidth != null) {
    env.windowWidth = window == null ? null : window.width
    env.windowHeight = window == null ? null : window.height

    if (env.windowWidth == null) {
      env.windowWidth = data.backgroundWidth.toString()
    }
    if (env.windowHeight == null) {
      env.windowHeight = data.backgroundHeight.toString()
    }

    if (env.windowX == null) {
      env.windowX = 400
    }
    if (env.windowY == null) {
      env.windowY = Math.round((1440 - env.windowHeight) / 2).toString()
    }
  }

  Object.assign(env, data)

  const asyncTaskManager = new AsyncTaskManager(packager.info.cancellationToken)
  env.iconLocations = await computeDmgEntries(specification, volumePath, packager, asyncTaskManager)
  await asyncTaskManager.awaitTasks()
  const executePython = async (execName: string) => {
    let pythonPath = process.env.PYTHON_PATH
    if (!pythonPath) {
      pythonPath = (await exec("which", [execName])).trim()
    }
    await exec(pythonPath, [path.join(getDmgVendorPath(), "dmgbuild/core.py")], {
      cwd: getDmgVendorPath(),
      env,
    })
  }
  try {
    await executePython("python3")
  } catch (_error: any) {
    await executePython("python")
  }
  return packager.packagerOptions.effectiveOptionComputed == null || !(await packager.packagerOptions.effectiveOptionComputed({ volumePath, specification, packager }))
}

async function computeDmgEntries(specification: DmgOptions, volumePath: string, packager: MacPackager, asyncTaskManager: AsyncTaskManager): Promise<string> {
  let result = ""
  for (const c of specification.contents!) {
    if (c.path != null && c.path.endsWith(".app") && c.type !== "link") {
      log.warn({ path: c.path, reason: "actual path to app will be used instead" }, "do not specify path for application")
    }

    const entryPath = c.path || `${packager.appInfo.productFilename}.app`
    const entryName = c.name || path.basename(entryPath)
    const escapedEntryName = entryName.replace(/['\\]/g, match => `\\${match}`)
    if (result.length !== 0) {
      result += ",\n"
    }
    result += `'${escapedEntryName}': (${c.x}, ${c.y})`

    if (c.type === "link") {
      asyncTaskManager.addTask(exec("ln", ["-s", `/${entryPath.startsWith("/") ? entryPath.substring(1) : entryPath}`, `${volumePath}/${entryName}`]))
    }
    // use c.path instead of entryPath (to be sure that this logic is not applied to .app bundle) https://github.com/electron-userland/electron-builder/issues/2147
    else if (!isEmptyOrSpaces(c.path) && (c.type === "file" || c.type === "dir")) {
      const source = await packager.getResource(c.path)
      if (source == null) {
        log.warn({ entryPath, reason: "doesn't exist" }, "skipped DMG item copying")
        continue
      }

      const destination = `${volumePath}/${entryName}`
      asyncTaskManager.addTask(c.type === "dir" || (await stat(source)).isDirectory() ? copyDir(source, destination) : copyFile(source, destination))
    }
  }
  return result
}

async function transformBackgroundFileIfNeed(file: string, tmpDir: TmpDir): Promise<string> {
  if (file.endsWith(".tiff") || file.endsWith(".TIFF")) {
    return file
  }

  const retinaFile = file.replace(/\.([a-z]+)$/, "@2x.$1")
  if (await exists(retinaFile)) {
    const tiffFile = await tmpDir.getTempFile({ suffix: ".tiff" })
    await exec("tiffutil", ["-cathidpicheck", file, retinaFile, "-out", tiffFile])
    return tiffFile
  }

  return file
}
