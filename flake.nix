{
  description = "FreeTube + Tabs — A private YouTube client with browser-style tabs";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        let
          # Patch the nixpkgs npm config hook to use modern env var names.
          # npm 11+ deprecated npm_config_nodedir/platform/arch; node-gyp
          # reads NODEDIR directly, and platform/arch are auto-detected.
          defaultNpmHook = (pkgs.buildPackages.npmHooks.override {
            nodejs = pkgs.nodejs;
          }).npmConfigHook;

          modernNpmConfigHook = pkgs.runCommand "npm-config-hook-modern" {} ''
            mkdir -p $out/nix-support
            sed \
              -e 's|export npm_config_nodedir=|export NODEDIR=|' \
              -e '/export npm_config_arch=/d' \
              -e '/export npm_config_platform=/d' \
              ${defaultNpmHook}/nix-support/setup-hook > $out/nix-support/setup-hook
          '';
        in
        {
          default = pkgs.buildNpmPackage rec {
            npmConfigHook = modernNpmConfigHook;
            pname = "freetube-plus-tabs";
            version = "0.24.5";

            # The repo targets a specific Electron major. If flake.lock goes
            # stale and nixpkgs ships an older Electron, the app runs on a
            # mismatched Chromium with silent assertion failures. This guard
            # fails the build loudly instead. Update with:
            #   nix flake update nixpkgs
            expectedElectronMajor = "41";
            passthru.electronVersion = pkgs.electron.version;

            src = ./.;

            npmDepsHash = "sha256-qXYVTnbPWEqdbRYdl3Swn1uZ9CNCyqmaJog1+hoXe3I=";
            npmDepsFetcherVersion = 2;
            npmFlags = [ "--legacy-peer-deps" ];
            makeCacheWritable = true;

            nativeBuildInputs = with pkgs; [
              makeWrapper
              copyDesktopItems
            ];

            env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

            buildPhase = let
              electronMajor = builtins.head (pkgs.lib.splitString "." pkgs.electron.version);
            in
              assert pkgs.lib.assertMsg (electronMajor == expectedElectronMajor)
                "flake.lock is stale: nixpkgs has Electron ${pkgs.electron.version} but the repo targets ${expectedElectronMajor}.x. Run: nix flake update nixpkgs";
            ''
              runHook preBuild
              node _scripts/patch-youtubei.js
              npm run pack
              runHook postBuild
            '';

            # electron-builder not needed — we wrap with nixpkgs electron
            dontNpmBuild = true;

            installPhase = ''
              runHook preInstall

              mkdir -p $out/lib/${pname}
              cp -r dist _icons package.json $out/lib/${pname}/

              makeWrapper ${pkgs.electron}/bin/electron $out/bin/${pname} \
                --add-flags "--enable-features=AcceleratedVideoDecodeLinuxGL,AcceleratedVideoEncoder,VaapiIgnoreDriverChecks" \
                --add-flags "--enable-gpu-rasterization" \
                --add-flags "--ozone-platform=wayland" \
                --add-flags "$out/lib/${pname}" \
                --set ELECTRON_IS_DEV 0 \
                --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath [ pkgs.libva ]}"

              install -Dm644 _icons/icon.svg $out/share/icons/hicolor/scalable/apps/${pname}.svg

              runHook postInstall
            '';

            desktopItems = [
              (pkgs.makeDesktopItem {
                name = pname;
                desktopName = "FreeTube + Tabs";
                genericName = "YouTube Client";
                comment = meta.description;
                exec = pname;
                icon = pname;
                terminal = false;
                startupWMClass = "FreeTube + Tabs";
                startupNotify = true;
                categories = [ "AudioVideo" "Network" "Video" ];
                mimeTypes = [ "x-scheme-handler/freetube" ];
              })
            ];

            meta = with pkgs.lib; {
              description = "A private YouTube client with browser-style tabs";
              homepage = "https://github.com/countgitmick/FreeTubePlusTabs";
              license = licenses.agpl3Plus;
              platforms = [ "x86_64-linux" "aarch64-linux" ];
              mainProgram = pname;
            };
          };
        });
    };
}
