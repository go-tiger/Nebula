import { Architecture, JdkDistribution, Platform, Server } from 'helios-distribution-types'

export interface UntrackedFilesOption {
    /**
     * The subdirectory these patterns will be applied to. Ex.
     * [ "files", "forgegemods" ]
     */
    appliesTo: string[]
    /**
     * Glob patterns to match against the file.
     */
    patterns: string[]
}

export interface ServerMetaOptions {
    version?: string
    forgeVersion?: string
    fabricVersion?: string
    neoForgeVersion?: string
}

export function getDefaultServerMeta(id: string, version: string, options?: ServerMetaOptions): ServerMeta {

    const servMeta: ServerMeta = {
        meta: {
            version: options?.version ?? '1.0.0',
            name: `${id} (Minecraft ${version})`,
            description: `Minecraft ${version}`,
            icon: 'https://github.com/mchdistro/레포/raw/main/server-icon.png',
            address: 'localhost:25565',
            discord: {
                shortId: '<FILL IN OR REMOVE DISCORD OBJECT>',
                largeImageText: '<FILL IN OR REMOVE DISCORD OBJECT>',
                largeImageKey: '<FILL IN OR REMOVE DISCORD OBJECT>'
            },
            mainServer: false,
            autoconnect: false,
            javaOptions: {
                supported: "=>21",
                suggestedMajor: 21,
                platformOptions: [
                    {
                        platform: Platform.WIN32,
                        architecture: Architecture.X64,
                        distribution: JdkDistribution.TEMURIN
                    }
                ],
                ram: {
                    minimum: 4096,
                    recommended: 8192
                }
            }
        }
    }

    if(options?.forgeVersion) {
        servMeta.meta.description = `${servMeta.meta.description} (Forge v${options.forgeVersion})`
        servMeta.forge = {
            version: options.forgeVersion
        }
    }

    if(options?.fabricVersion) {
        servMeta.meta.description = `${servMeta.meta.description} (Fabric v${options.fabricVersion})`
        servMeta.fabric = {
            version: options.fabricVersion
        }
    }

    if(options?.neoForgeVersion) {
        servMeta.meta.description = `${servMeta.meta.description} (NeoForge v${options.neoForgeVersion})`
        servMeta.neoforge = {
            version: options.neoForgeVersion
        }
    }

    // Add empty untracked files.
    servMeta.untrackedFiles = [{ appliesTo: ['files'], patterns: ['options.txt'] }];

    return servMeta
}

export interface ServerMeta {

    /**
     * Server metadata to be forwarded to the distribution file.
     */
    meta: {
        version: Server['version']
        name: Server['name']
        description: Server['description']
        icon?: Server['icon']
        address: Server['address']
        discord?: Server['discord']
        mainServer: Server['mainServer']
        autoconnect: Server['autoconnect']
        javaOptions?: Server['javaOptions']
    }

    /**
     * Properties related to Forge.
     */
    forge?: {
        /**
         * The forge version. This does NOT include the minecraft version.
         * Ex. 14.23.5.2854
         */
        version: string
    }

    /**
     * Properties related to Fabric.
     */
    fabric?: {
        /**
         * The fabric loader version. This does NOT include the minecraft version.
         * Ex. 0.14.18
         */
        version: string
    }

    /**
     * Properties related to NeoForge.
     */
    neoforge?: {
        /**
         * The NeoForge version. This does NOT include the minecraft version.
         * Ex. 20.4.80
         */
        version: string
    }

    /**
     * A list of option objects defining patterns for untracked files.
     */
    untrackedFiles?: UntrackedFilesOption[]

}
