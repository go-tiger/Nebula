import StreamZip from 'node-stream-zip'
import toml from 'toml'
import { capitalize } from '../../../../util/StringUtils.js'
import { ModsToml } from '../../../../model/forge/ModsToml.js'
import { BaseNeoForgeModStructure } from '../NeoForgeMod.struct.js'
import { MinecraftVersion } from '../../../../util/MinecraftVersion.js'
import { UntrackedFilesOption } from '../../../../model/nebula/ServerMeta.js'

export class NeoForgeModStructure120 extends BaseNeoForgeModStructure<ModsToml> {

    public static readonly IMPLEMENTATION_VERSION_REGEX = /^Implementation-Version: (.+)[\r\n]/

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public static isForVersion(version: MinecraftVersion, libraryVersion: string): boolean {
        // NeoForge is available for 1.20.1+
        return version.isGreaterThanOrEqualTo(new MinecraftVersion('1.20.1'))
    }

    constructor(
        absoluteRoot: string,
        relativeRoot: string,
        baseUrl: string,
        minecraftVersion: MinecraftVersion,
        untrackedFiles: UntrackedFilesOption[]
    ) {
        super(absoluteRoot, relativeRoot, baseUrl, minecraftVersion, untrackedFiles)
    }

    public isForVersion(version: MinecraftVersion, libraryVersion: string): boolean {
        return NeoForgeModStructure120.isForVersion(version, libraryVersion)
    }

    public getLoggerName(): string {
        return 'NeoForgeModStructure (1.20+)'
    }

    protected async getModuleId(name: string, path: string): Promise<string> {
        const fmData = await this.getModMetadata(name, path)
        return this.generateMavenIdentifier(this.getClaritasGroup(path), fmData.mods[0].modId, fmData.mods[0].version)
    }
    protected async getModuleName(name: string, path: string): Promise<string> {
        return capitalize((await this.getModMetadata(name, path)).mods[0].displayName)
    }

    protected processZip(zip: StreamZip, name: string, path: string): ModsToml {

        // Optifine is a tweak that can be loaded as a neoforge mod. It does not
        // appear to contain a mcmod.info class. This a special case we will
        // account for.
        if (name.toLowerCase().includes('optifine')) {

            // Read zip for changelog.txt
            let changelogBuf: Buffer
            try {
                changelogBuf = zip.entryDataSync('changelog.txt')
            } catch(err) {
                throw new Error('Failed to read OptiFine changelog.')
            }

            const info = changelogBuf.toString().split('\n')[0].trim()
            const version = info.split(' ')[1]

            this.modMetadata[name] = ({
                modLoader: 'javafml',
                loaderVersion: '',
                mods: [{
                    modId: 'optifine',
                    version,
                    displayName: 'OptiFine',
                    description: `OptiFine is a Minecraft optimization mod.
                    It allows Minecraft to run faster and look better with full support for shaders, HD textures and many configuration options.`
                }]
            })

            return this.modMetadata[name]
        }

        let raw: Buffer | undefined
        try {
            raw = zip.entryDataSync('META-INF/mods.toml')
        } catch(err) {
            // ignored
        }

        if (raw) {
            try {
                const parsed = toml.parse(raw.toString()) as ModsToml
                this.modMetadata[name] = parsed
            } catch (err) {
                this.logger.error(`NeoForgeMod ${name} contains an invalid mods.toml file.`)
            }
        } else {
            this.logger.error(`NeoForgeMod ${name} does not contain mods.toml file.`)
        }

        const cRes = this.claritasResult?.[path]

        if(cRes == null) {
            this.logger.error(`Claritas failed to yield metadata for NeoForgeMod ${name}!`)
            this.logger.error('Is this mod malformatted or does Claritas need an update?')
        }

        const claritasId = cRes?.id

        const crudeInference = this.attemptCrudeInference(name)

        if(this.modMetadata[name] != null) {

            const x = this.modMetadata[name]
            for(const entry of x.mods) {

                if(entry.modId === this.EXAMPLE_MOD_ID) {
                    entry.modId = this.discernResult(claritasId, crudeInference.name.toLowerCase())
                    entry.displayName = crudeInference.name
                }

                if (entry.version === '${file.jarVersion}') {
                    let version = crudeInference.version
                    try {
                        const manifest = zip.entryDataSync('META-INF/MANIFEST.MF')
                        const keys = manifest.toString().split('\n')
                        // this.logger.debug(keys)
                        for (const key of keys) {
                            const match = NeoForgeModStructure120.IMPLEMENTATION_VERSION_REGEX.exec(key)
                            if (match != null) {
                                version = match[1]
                            }
                        }
                        this.logger.debug(`NeoForgeMod ${name} contains a version wildcard, inferring ${version}`)
                    } catch {
                        this.logger.debug(`NeoForgeMod ${name} contains a version wildcard yet no MANIFEST.MF.. Defaulting to ${version}`)
                    }
                    entry.version = version
                }
            }

        } else {
            this.modMetadata[name] = ({
                modLoader: 'javafml',
                loaderVersion: '',
                mods: [{
                    modId: this.discernResult(claritasId, crudeInference.name.toLowerCase()),
                    version: crudeInference.version,
                    displayName: crudeInference.name,
                    description: ''
                }]
            })
        }

        return this.modMetadata[name]
    }

}
