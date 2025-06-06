import { AllPublishOptions, newError } from "builder-util-runtime"
import { execFileSync } from "child_process"
import { chmod } from "fs-extra"
import { unlinkSync } from "fs"
import * as path from "path"
import { DownloadUpdateOptions } from "./AppUpdater"
import { BaseUpdater, InstallOptions } from "./BaseUpdater"
import { DifferentialDownloaderOptions } from "./differentialDownloader/DifferentialDownloader"
import { FileWithEmbeddedBlockMapDifferentialDownloader } from "./differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader"
import { findFile, Provider } from "./providers/Provider"
import { DOWNLOAD_PROGRESS, ResolvedUpdateFileInfo } from "./types"

export class AppImageUpdater extends BaseUpdater {
  constructor(options?: AllPublishOptions | null, app?: any) {
    super(options, app)
  }

  public isUpdaterActive(): boolean {
    if (process.env["APPIMAGE"] == null && !this.forceDevUpdateConfig) {
      if (process.env["SNAP"] == null) {
        this._logger.warn("APPIMAGE env is not defined, current application is not an AppImage")
      } else {
        this._logger.info("SNAP env is defined, updater is disabled")
      }
      return false
    }
    return super.isUpdaterActive()
  }

  /*** @private */
  protected doDownloadUpdate(downloadUpdateOptions: DownloadUpdateOptions): Promise<Array<string>> {
    const provider = downloadUpdateOptions.updateInfoAndProvider.provider
    const fileInfo = findFile(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), "AppImage", ["rpm", "deb", "pacman"])!
    return this.executeDownload({
      fileExtension: "AppImage",
      fileInfo,
      downloadUpdateOptions,
      task: async (updateFile, downloadOptions) => {
        const oldFile = process.env["APPIMAGE"]!
        if (oldFile == null) {
          throw newError("APPIMAGE env is not defined", "ERR_UPDATER_OLD_FILE_NOT_FOUND")
        }

        if (downloadUpdateOptions.disableDifferentialDownload || (await this.downloadDifferential(fileInfo, oldFile, updateFile, provider, downloadUpdateOptions))) {
          await this.httpExecutor.download(fileInfo.url, updateFile, downloadOptions)
        }

        await chmod(updateFile, 0o755)
      },
    })
  }

  private async downloadDifferential(fileInfo: ResolvedUpdateFileInfo, oldFile: string, updateFile: string, provider: Provider<any>, downloadUpdateOptions: DownloadUpdateOptions) {
    try {
      const downloadOptions: DifferentialDownloaderOptions = {
        newUrl: fileInfo.url,
        oldFile,
        logger: this._logger,
        newFile: updateFile,
        isUseMultipleRangeRequest: provider.isUseMultipleRangeRequest,
        requestHeaders: downloadUpdateOptions.requestHeaders,
        cancellationToken: downloadUpdateOptions.cancellationToken,
      }

      if (this.listenerCount(DOWNLOAD_PROGRESS) > 0) {
        downloadOptions.onProgress = it => this.emit(DOWNLOAD_PROGRESS, it)
      }

      await new FileWithEmbeddedBlockMapDifferentialDownloader(fileInfo.info, this.httpExecutor, downloadOptions).download()
      return false
    } catch (e: any) {
      this._logger.error(`Cannot download differentially, fallback to full download: ${e.stack || e}`)
      // during test (developer machine mac) we must throw error
      return process.platform === "linux"
    }
  }

  protected doInstall(options: InstallOptions): boolean {
    const appImageFile = process.env["APPIMAGE"]!
    if (appImageFile == null) {
      throw newError("APPIMAGE env is not defined", "ERR_UPDATER_OLD_FILE_NOT_FOUND")
    }

    // https://stackoverflow.com/a/1712051/1910191
    unlinkSync(appImageFile)

    let destination: string
    const existingBaseName = path.basename(appImageFile)
    const installerPath = this.installerPath
    if (installerPath == null) {
      this.dispatchError(new Error("No update filepath provided, can't quit and install"))
      return false
    }
    // https://github.com/electron-userland/electron-builder/issues/2964
    // if no version in existing file name, it means that user wants to preserve current custom name
    if (path.basename(installerPath) === existingBaseName || !/\d+\.\d+\.\d+/.test(existingBaseName)) {
      // no version in the file name, overwrite existing
      destination = appImageFile
    } else {
      destination = path.join(path.dirname(appImageFile), path.basename(installerPath))
    }

    execFileSync("mv", ["-f", installerPath, destination])
    if (destination !== appImageFile) {
      this.emit("appimage-filename-updated", destination)
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      APPIMAGE_SILENT_INSTALL: "true",
    }

    if (options.isForceRunAfter) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this.spawnLog(destination, [], env)
    } else {
      env.APPIMAGE_EXIT_AFTER_INSTALL = "true"
      execFileSync(destination, [], { env })
    }
    return true
  }
}
