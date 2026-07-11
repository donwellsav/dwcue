vcpkg_from_github(
    OUT_SOURCE_PATH SOURCE_PATH
    REPO libgme/game-music-emu
    REF 0.6.5
    SHA512 c28fc36098f5e083ef43cda3f037275d7f071868ab44abf577da3f07bd9f2ffae8a65fa842b060df42baa98ad6b5f42817001749fb3c08a4023dea7334d513e9
)

vcpkg_cmake_configure(
    SOURCE_PATH "${SOURCE_PATH}"
    OPTIONS
        -DGME_BUILD_SHARED=OFF
        -DGME_BUILD_STATIC=ON
        -DGME_BUILD_TESTING=OFF
        -DGME_BUILD_EXAMPLES=OFF
        -DGME_ZLIB=ON
)
vcpkg_cmake_install()
vcpkg_fixup_pkgconfig()

file(REMOVE_RECURSE "${CURRENT_PACKAGES_DIR}/debug/include")
vcpkg_install_copyright(FILE_LIST "${SOURCE_PATH}/license.txt")
