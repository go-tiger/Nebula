import { NeoForgeResolver } from '../NeoForge.resolver.js'
import { MinecraftVersion } from '../../../util/MinecraftVersion.js'
import { LoggerUtil } from '../../../util/LoggerUtil.js'
import { Module, Type } from 'helios-distribution-types'
import { LibRepoStructure } from '../../../structure/repo/LibRepo.struct.js'
import { pathExists, remove, mkdirs, copy, writeJson } from 'fs-extra/esm'
import { lstat, readFile, writeFile } from 'fs/promises'
import { join, basename, dirname } from 'path'
import { spawn } from 'child_process'
import { JavaUtil } from '../../../util/java/JavaUtil.js'
import { VersionManifestFG3 } from '../../../model/forge/VersionManifestFG3.js'
import { MavenUtil } from '../../../util/MavenUtil.js'
import { createHash } from 'crypto'

interface GeneratedFile {
    name: string
    group: string
    artifact: string
    version: string
    classifiers: string[] | [undefined]
    skipIfNotPresent?: boolean
    classpath?: boolean
}

export class NeoForgeAdapter extends NeoForgeResolver {

    private static readonly logger = LoggerUtil.getLogger('NeoForge Adapter')

    public static isForVersion(version: MinecraftVersion, _libraryVersion: string): boolean {
        // NeoForge is available for 1.20.1+
        return version.isGreaterThanOrEqualTo(new MinecraftVersion('1.20.1'))
    }

    public static isExecutableJar(version: MinecraftVersion): boolean {
        // NeoForge 1.20.2+ can use executable jars directly
        return version.isGreaterThanOrEqualTo(new MinecraftVersion('1.20.2'))
    }

    private generatedFiles: GeneratedFile[] | undefined

    constructor(
        absoluteRoot: string,
        relativeRoot: string,
        baseUrl: string,
        minecraftVersion: MinecraftVersion,
        neoForgeVersion: string,
        discardOutput: boolean,
        invalidateCache: boolean
    ) {
        super(absoluteRoot, relativeRoot, baseUrl, minecraftVersion, neoForgeVersion, discardOutput, invalidateCache)
        this.configure()
    }

    private configure(): void {

        // Configure for 1.20.1+
        // Note: Newer NeoForge versions may not generate all these files separately
        // They might be bundled into the universal jar
        this.generatedFiles = [
            {
                name: 'neoforge jar',
                group: LibRepoStructure.NEOFORGE_GROUP,
                artifact: LibRepoStructure.NEOFORGE_ARTIFACT,
                version: this.artifactVersion,
                classifiers: ['universal']
            },
            {
                name: 'fmlcore',
                group: LibRepoStructure.NEOFORGE_GROUP,
                artifact: LibRepoStructure.NEOFORGE_FMLCORE_ARTIFACT,
                version: this.artifactVersion,
                classifiers: [undefined],
                skipIfNotPresent: true
            },
            {
                name: 'javafmllanguage',
                group: LibRepoStructure.NEOFORGE_GROUP,
                artifact: LibRepoStructure.NEOFORGE_JAVAFMLLANGUAGE_ARTIFACT,
                version: this.artifactVersion,
                classifiers: [undefined],
                skipIfNotPresent: true
            },
            {
                name: 'mclanguage',
                group: LibRepoStructure.NEOFORGE_GROUP,
                artifact: LibRepoStructure.NEOFORGE_MCLANGUAGE_ARTIFACT,
                version: this.artifactVersion,
                classifiers: [undefined],
                skipIfNotPresent: true
            },
            {
                name: 'lowcodelanguage',
                group: LibRepoStructure.NEOFORGE_GROUP,
                artifact: LibRepoStructure.NEOFORGE_LOWCODELANGUAGE_ARTIFACT,
                version: this.artifactVersion,
                classifiers: [undefined],
                skipIfNotPresent: true
            }
        ]
    }

    public async getModule(): Promise<Module> {
        return this.process()
    }

    public isForVersion(version: MinecraftVersion, libraryVersion: string): boolean {
        return NeoForgeAdapter.isForVersion(version, libraryVersion)
    }

    private async process(): Promise<Module> {
        const libRepo = this.repoStructure.getLibRepoStruct()

        // Get Installer
        const installerPath = libRepo.getLocalNeoForge(this.artifactVersion, 'installer')
        NeoForgeAdapter.logger.debug(`Checking for NeoForge installer at ${installerPath}..`)
        if (!await libRepo.artifactExists(installerPath)) {
            NeoForgeAdapter.logger.debug('NeoForge installer not found locally, initializing download..')
            await libRepo.downloadArtifactByComponents(
                this.REMOTE_REPOSITORY,
                LibRepoStructure.NEOFORGE_GROUP,
                LibRepoStructure.NEOFORGE_ARTIFACT,
                this.artifactVersion, 'installer', 'jar'
            )
        } else {
            NeoForgeAdapter.logger.debug('Using locally discovered NeoForge installer.')
        }
        NeoForgeAdapter.logger.debug(`Beginning processing of NeoForge v${this.neoForgeVersion} (Minecraft ${this.minecraftVersion})`)

        if(this.generatedFiles != null && this.generatedFiles.length > 0) {
            // Run installer
            return this.processWithInstaller(installerPath)
        } else {
            // Installer not required
            return this.processWithoutInstaller(installerPath)
        }

    }

    private async processWithInstaller(installerPath: string): Promise<Module> {

        let doInstall = true
        // Check cache.
        const cacheDir = this.repoStructure.getNeoForgeCacheDirectory(this.artifactVersion)
        if (await pathExists(cacheDir)) {
            if(this.invalidateCache) {
                NeoForgeAdapter.logger.info(`Removing existing cache ${cacheDir}..`)
                await remove(cacheDir)
            } else {
                // Use cache.
                doInstall = false
                NeoForgeAdapter.logger.info(`Using cached results at ${cacheDir}.`)
            }
        } else {
            await mkdirs(cacheDir)
        }
        const installerOutputDir = cacheDir

        if(doInstall) {
            const workingInstaller = join(installerOutputDir, basename(installerPath))

            await copy(installerPath, workingInstaller)

            // Required for the installer to function.
            await writeFile(join(installerOutputDir, 'launcher_profiles.json'), JSON.stringify({}))

            NeoForgeAdapter.logger.debug('Spawning NeoForge installer')

            NeoForgeAdapter.logger.info('============== [ IMPORTANT ] ==============')
            NeoForgeAdapter.logger.info('When the installer opens please set the client installation directory to:')
            NeoForgeAdapter.logger.info(installerOutputDir)
            NeoForgeAdapter.logger.info('===========================================')

            await this.executeInstaller(workingInstaller)

            NeoForgeAdapter.logger.debug('Installer finished, beginning processing..')
        }

        await this.verifyInstallerRan(installerOutputDir)

        NeoForgeAdapter.logger.debug('Processing Version Manifest')
        const versionManifestTuple = await this.processVersionManifest(installerOutputDir)
        const versionManifest = versionManifestTuple[0]

        NeoForgeAdapter.logger.debug('Processing generated NeoForge files.')
        const neoforgeModule = await this.processNeoForgeModule(versionManifest, installerOutputDir)

        // Attach version.json module.
        neoforgeModule.subModules?.unshift(versionManifestTuple[1])

        NeoForgeAdapter.logger.debug('Processing Libraries')
        const libs = await this.processLibraries(versionManifest, installerOutputDir)

        neoforgeModule.subModules = neoforgeModule.subModules?.concat(libs)

        if(this.discardOutput) {
            NeoForgeAdapter.logger.info(`Removing installer output at ${installerOutputDir}..`)
            await remove(installerOutputDir)
            NeoForgeAdapter.logger.info('Removed successfully.')
        }

        return neoforgeModule

    }

    private async getVersionManifestPath(installerOutputDir: string): Promise<string> {
        const versionsDir = join(installerOutputDir, 'versions')

        // NeoForge installer might create a version folder with a different name pattern
        // Try to find it by scanning the versions directory
        if (await pathExists(versionsDir)) {
            const { readdir } = await import('fs/promises')
            const versionFolders = await readdir(versionsDir)

            // Look for folders that contain neoforge or match the version pattern
            for (const folder of versionFolders) {
                const potentialPath = join(versionsDir, folder, `${folder}.json`)
                if (await pathExists(potentialPath)) {
                    NeoForgeAdapter.logger.debug(`Found version manifest at ${potentialPath}`)
                    return potentialPath
                }
            }
        }

        // Fallback to expected path
        const versionRepo = this.repoStructure.getVersionRepoStruct()
        const versionName = versionRepo.getFileName(this.minecraftVersion, this.neoForgeVersion)
        return join(installerOutputDir, 'versions', versionName, `${versionName}.json`)
    }

    private async verifyInstallerRan(installerOutputDir: string): Promise<void> {
        const versionManifestPath = await this.getVersionManifestPath(installerOutputDir)

        if(!await pathExists(versionManifestPath)) {
            await remove(installerOutputDir)
            throw new Error(`NeoForge was either not installed or installed to the wrong location. When the NeoForge installer opens, you MUST set the installation directory to ${installerOutputDir}`)
        }
    }

    private async processVersionManifest(installerOutputDir: string): Promise<[VersionManifestFG3, Module]> {
        const versionRepo = this.repoStructure.getVersionRepoStruct()
        const versionManifestPath = await this.getVersionManifestPath(installerOutputDir)

        const versionManifestBuf = await readFile(versionManifestPath)
        const versionManifest = JSON.parse(versionManifestBuf.toString()) as VersionManifestFG3

        const versionManifestModule: Module = {
            id: `${this.minecraftVersion}-${this.neoForgeVersion}`,
            name: 'NeoForge (version.json)',
            type: Type.VersionManifest,
            artifact: this.generateArtifact(
                versionManifestBuf,
                await lstat(versionManifestPath),
                versionRepo.getVersionManifestURL(this.baseUrl, this.minecraftVersion, this.neoForgeVersion)
            )
        }

        const destination = versionRepo.getVersionManifest(
            this.minecraftVersion,
            this.neoForgeVersion
        )

        await copy(versionManifestPath, destination, {overwrite: true})

        return [versionManifest, versionManifestModule]
    }

    private async processNeoForgeModule(versionManifest: VersionManifestFG3, installerOutputDir: string): Promise<Module> {

        const libDir = join(installerOutputDir, 'libraries')

        const mdls: Module[] = []

        for (const entry of this.generatedFiles!) {

            const targetLocations: string[] = []
            let located = false

            classifierLoop:
            for (const _classifier of entry.classifiers) {

                const targetLocalPath = join(
                    libDir,
                    MavenUtil.mavenComponentsAsNormalizedPath(entry.group, entry.artifact, entry.version, _classifier)
                )

                targetLocations.push(targetLocalPath)

                const exists = await pathExists(targetLocalPath)
                if (exists) {

                    mdls.push({
                        id: MavenUtil.mavenComponentsToIdentifier(
                            entry.group,
                            entry.artifact,
                            entry.version,
                            _classifier
                        ),
                        name: `NeoForge (${entry.name})`,
                        type: Type.Library,
                        classpath: entry.classpath ?? true,
                        artifact: this.generateArtifact(
                            await readFile(targetLocalPath),
                            await lstat(targetLocalPath),
                            this.repoStructure.getLibRepoStruct().getArtifactUrlByComponents(
                                this.baseUrl,
                                entry.group,
                                entry.artifact,
                                entry.version,
                                _classifier
                            )
                        ),
                        subModules: []
                    })

                    const destination = this.repoStructure.getLibRepoStruct().getArtifactByComponents(
                        entry.group,
                        entry.artifact,
                        entry.version,
                        _classifier
                    )

                    await copy(targetLocalPath, destination, {overwrite: true})

                    located = true
                    break classifierLoop

                }

            }

            if (!entry.skipIfNotPresent && !located) {
                throw new Error(`Required file ${entry.name} not found at any expected location:\n\t${targetLocations.join('\n\t')}`)
            }

        }

        const neoforgeModule = mdls.shift()!
        neoforgeModule.type = Type.ForgeHosted
        neoforgeModule.subModules = mdls

        return neoforgeModule
    }

    private async processLibraries(manifest: VersionManifestFG3, installerOutputDir: string): Promise<Module[]> {

        const libDir = join(installerOutputDir, 'libraries')
        const libRepo = this.repoStructure.getLibRepoStruct()

        const mdls: Module[] = []

        for (const entry of manifest.libraries) {
            const artifact = entry.downloads.artifact
            if (artifact.url) {

                const targetLocalPath = join(libDir, artifact.path)

                // Some libraries may not be downloaded by the installer (e.g., OS-specific libraries)
                // Skip them if they don't exist
                if (!await pathExists(targetLocalPath)) {
                    NeoForgeAdapter.logger.debug(`Library ${entry.name} not found at ${targetLocalPath}, skipping (may be OS-specific)`)
                    continue
                }

                const components = MavenUtil.getMavenComponents(entry.name)

                mdls.push({
                    id: entry.name,
                    name: `NeoForge (${components.artifact})`,
                    type: Type.Library,
                    artifact: this.generateArtifact(
                        await readFile(targetLocalPath),
                        await lstat(targetLocalPath),
                        libRepo.getArtifactUrlByComponents(
                            this.baseUrl,
                            components.group,
                            components.artifact,
                            components.version,
                            components.classifier,
                            components.extension
                        )
                    )
                })
                const destination = libRepo.getArtifactByComponents(
                    components.group,
                    components.artifact,
                    components.version,
                    components.classifier,
                    components.extension
                )

                await copy(targetLocalPath, destination, {overwrite: true})

            }
        }

        return mdls

    }

    private executeInstaller(installerExec: string): Promise<void> {
        return new Promise(resolve => {
            const fiLogger = LoggerUtil.getLogger('NeoForge Installer')
            const child = spawn(JavaUtil.getJavaExecutable(), [
                '-jar',
                installerExec
            ], {
                cwd: dirname(installerExec)
            })
            child.stdout.on('data', (data) => fiLogger.info(data.toString('utf8').trim()))
            child.stderr.on('data', (data) => fiLogger.error(data.toString('utf8').trim()))
            child.on('close', code => {
                if(code === 0) {
                    fiLogger.info('Exited with code', code)
                } else {
                    fiLogger.error('Exited with code', code)
                }

                resolve()
            })
        })
    }

    private async processWithoutInstaller(installerPath: string): Promise<Module> {

        // Extract version.json from installer.

        let versionManifestBuf: Buffer
        try {
            versionManifestBuf = await this.getVersionManifestFromJar(installerPath)
        } catch(err) {
            throw new Error('Failed to find version.json in NeoForge installer jar.')
        }

        const versionManifest = JSON.parse(versionManifestBuf.toString()) as VersionManifestFG3

        // Save Version Manifest
        const versionManifestDest = this.repoStructure.getVersionRepoStruct().getVersionManifest(
            this.minecraftVersion,
            this.neoForgeVersion
        )
        await mkdirs(dirname(versionManifestDest))
        await writeJson(versionManifestDest, versionManifest, { spaces: 4 })

        const libRepo = this.repoStructure.getLibRepoStruct()
        const neoforgeLocalPath = libRepo.getLocalNeoForge(this.artifactVersion)
        NeoForgeAdapter.logger.debug(`Checking for NeoForge jar at ${neoforgeLocalPath}..`)

        const neoforgeMdl = versionManifest.libraries.find(val =>
            val.name.startsWith('net.neoforged:neoforge:') || val.name.startsWith('net.neoforged:forge:'))

        if(neoforgeMdl == null) {
            throw new Error('NeoForge entry not found in version.json!')
        }

        let neoforgeBuffer

        // Check for local neoforge jar.
        if (await libRepo.artifactExists(neoforgeLocalPath)) {
            const localNeoBuf = await readFile(neoforgeLocalPath)
            const sha1 = createHash('sha1').update(localNeoBuf).digest('hex')
            if(sha1 !== neoforgeMdl.downloads.artifact.sha1) {
                NeoForgeAdapter.logger.debug('SHA-1 of local NeoForge jar does not match version.json entry.')
                NeoForgeAdapter.logger.debug('Redownloading NeoForge jar..')
            } else {
                NeoForgeAdapter.logger.debug('Using locally discovered NeoForge.')
                neoforgeBuffer = localNeoBuf
            }
        } else {
            NeoForgeAdapter.logger.debug('NeoForge jar not found locally, initializing download..')
        }

        // Download if local is missing or corrupt
        if(!neoforgeBuffer) {
            await libRepo.downloadArtifactByComponents(
                this.REMOTE_REPOSITORY,
                LibRepoStructure.NEOFORGE_GROUP,
                LibRepoStructure.NEOFORGE_ARTIFACT,
                this.artifactVersion, undefined, 'jar')
            neoforgeBuffer = await readFile(neoforgeLocalPath)
        }

        NeoForgeAdapter.logger.debug(`Beginning processing of NeoForge v${this.neoForgeVersion} (Minecraft ${this.minecraftVersion})`)

        const neoforgeModule: Module = {
            id: MavenUtil.mavenComponentsToIdentifier(
                LibRepoStructure.NEOFORGE_GROUP,
                LibRepoStructure.NEOFORGE_ARTIFACT,
                this.artifactVersion
            ),
            name: 'NeoForge',
            type: Type.ForgeHosted,
            artifact: this.generateArtifact(
                neoforgeBuffer,
                await lstat(neoforgeLocalPath),
                libRepo.getArtifactUrlByComponents(
                    this.baseUrl,
                    LibRepoStructure.NEOFORGE_GROUP,
                    LibRepoStructure.NEOFORGE_ARTIFACT,
                    this.artifactVersion
                )
            ),
            subModules: []
        }

        // Attach Version Manifest module.
        neoforgeModule.subModules?.push({
            id: `${this.minecraftVersion}-${this.neoForgeVersion}`,
            name: 'NeoForge (version.json)',
            type: Type.VersionManifest,
            artifact: this.generateArtifact(
                await readFile(versionManifestDest),
                await lstat(versionManifestDest),
                this.repoStructure.getVersionRepoStruct().getVersionManifestURL(
                    this.baseUrl, this.minecraftVersion, this.neoForgeVersion)
            )
        })

        for(const lib of versionManifest.libraries) {
            if (lib.name.startsWith('net.neoforged:neoforge:') || lib.name.startsWith('net.neoforged:forge:')) {
                // We've already processed neoforge.
                continue
            }
            NeoForgeAdapter.logger.debug(`Processing ${lib.name}..`)

            const extension = 'jar'
            const localPath = libRepo.getArtifactById(lib.name, extension)

            let queueDownload = !await libRepo.artifactExists(localPath)
            let libBuf

            if (!queueDownload) {
                libBuf = await readFile(localPath)
                const sha1 = createHash('sha1').update(libBuf).digest('hex')
                if (sha1 !== lib.downloads.artifact.sha1) {
                    NeoForgeAdapter.logger.debug('Hashes do not match, redownloading..')
                    queueDownload = true
                }
            } else {
                NeoForgeAdapter.logger.debug('Not found locally, downloading..')
                queueDownload = true
            }

            if (queueDownload) {
                await libRepo.downloadArtifactDirect(lib.downloads.artifact.url, lib.downloads.artifact.path)
                libBuf = await readFile(localPath)
            } else {
                NeoForgeAdapter.logger.debug('Using local copy.')
            }

            const stats = await lstat(localPath)

            const mavenComponents = MavenUtil.getMavenComponents(lib.name)
            const properId = MavenUtil.mavenComponentsToIdentifier(
                mavenComponents.group, mavenComponents.artifact, mavenComponents.version,
                mavenComponents.classifier, extension
            )

            neoforgeModule.subModules?.push({
                id: properId,
                name: `NeoForge (${mavenComponents?.artifact})`,
                type: Type.Library,
                artifact: this.generateArtifact(
                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                    libBuf!,
                    stats,
                    libRepo.getArtifactUrlByComponents(
                        this.baseUrl,
                        mavenComponents.group, mavenComponents.artifact,
                        mavenComponents.version, mavenComponents.classifier, extension
                    )
                )
            })

        }

        return neoforgeModule

    }

}
