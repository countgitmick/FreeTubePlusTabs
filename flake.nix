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
        {
          default = pkgs.buildNpmPackage rec {
            pname = "freetube-plus-tabs";
            version = "0.23.15";

            src = ./.;

            npmDepsHash = "sha256-YCNf9t8IUDWFU4v1gxzIskK4m3vZ1q10bbxRHMDyivw=";
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
                --add-flags "$out/lib/${pname}/dist/main.js" \
                --set ELECTRON_IS_DEV 0

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
