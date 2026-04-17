import StreamZip from 'node-stream-zip'
import { RepoStructure } from '../../structure/repo/Repo.struct.js'
import { BaseResolver } from '../BaseResolver.js'
import { MinecraftVersion } from '../../util/MinecraftVersion.js'

export abstract class NeoForgeResolver extends BaseResolver {

    protected readonly MOJANG_REMOTE_REPOSITORY = 'https://libraries.minecraft.net/'
    protected readonly REMOTE_REPOSITORY = 'https://maven.neoforged.net/releases/'

    protected repoStructure: RepoStructure
    protected artifactVersion: string

    constructor(
        absoluteRoot: string,
        relativeRoot: string,
        baseUrl: string,
        protected minecraftVersion: MinecraftVersion,
        protected neoForgeVersion: string,
        protected discardOutput: boolean,
        protected invalidateCache: boolean
    ) {
        super(absoluteRoot, relativeRoot, baseUrl)
        this.repoStructure = new RepoStructure(absoluteRoot, relativeRoot, 'neoforge')
        this.artifactVersion = this.inferArtifactVersion()
    }

    public inferArtifactVersion(): string {
        // NeoForge does not include minecraft version in artifact version
        // e.g., NeoForge version 21.0.167 for Minecraft 1.21.0
        // If user provides version like "1.20.1-20.1.48", extract only "20.1.48"
        const parts = this.neoForgeVersion.split('-')
        if (parts.length === 2 && parts[0].match(/^\d+\.\d+/)) {
            // Format: "1.20.1-20.1.48" -> "20.1.48"
            return parts[1]
        }
        // Already in correct format: "20.1.48"
        return this.neoForgeVersion
    }

    protected async getVersionManifestFromJar(jarPath: string): Promise<Buffer>{
        return new Promise((resolve, reject) => {
            const zip = new StreamZip({
                file: jarPath,
                storeEntries: true
            })
            zip.on('ready', () => {
                try {
                    const data = zip.entryDataSync('version.json')
                    zip.close()
                    resolve(data)
                } catch(err) {
                    reject(err)
                }

            })
            zip.on('error', err => reject(err))
        })
    }

}
