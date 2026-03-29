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
            version = "0.24.3";

            src = ./.;

            npmDepsHash = "sha256-eZGHXZr1rnuWjJcHUn24XIaePHp4J+4DFVoRLksgtoo=";
            npmDepsFetcherVersion = 2;
            npmFlags = [ "--legacy-peer-deps" ];
            makeCacheWritable = true;

            nativeBuildInputs = with pkgs; [
              makeWrapper
              copyDesktopItems
            ];

            env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

            buildPhase = ''
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
                --add-flags "$out/lib/${pname}/dist/main.js" \
                --set ELECTRON_IS_DEV 0 \
                --prefix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath [ pkgs.libva ]}"

              install -Dm644 _icons/icon.svg $out/share/icons/hicolor/scalable/apps/${pname}.svg

              runHook postInstall
            '';

            desktopItems = [
              (pkgs.makeDesktopItem {
                name = pname;
                desktopName = "FreeTube + Tabs";
                comment = meta.description;
                exec = pname;
                icon = pname;
                terminal = false;
                categories = [ "Network" "Video" ];
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
