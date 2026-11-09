import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    id("java")
    kotlin("jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "io.siglo"
version = "1.2.1"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
        intellijDependencies()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.1.4")
        bundledPlugins("com.intellij.java")
        instrumentationTools()
        pluginVerifier()
        zipSigner()
    }

    implementation("com.google.code.gson:gson:2.11.0")

    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    jvmToolchain(17)
}

intellijPlatform {
    pluginConfiguration {
        id = "io.siglo.idea"
        name = "Siglo Workflows"
        version = project.version.toString()
        vendor {
            name = "Siglo"
            url = "https://github.com/jsoftgem/siglo"
        }
        description = file("marketplace/description.html").readText()
        ideaVersion {
            sinceBuild = "241"
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ides {
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2024.1.4")
        }
    }
}

tasks.test {
    useJUnitPlatform()
}
