# Crow 1.3.2 writes both media bodies and static files synchronously on its
# control I/O workers. Patch a build-local copy; never mutate the vcpkg tree.
find_package(Git REQUIRED)
get_target_property(_crow_include_dirs Crow::Crow INTERFACE_INCLUDE_DIRECTORIES)
find_path(DWCUE_CROW_INCLUDE_DIR crow/http_connection.h HINTS ${_crow_include_dirs} REQUIRED)
set(DWCUE_CROW_ASYNC_INCLUDE_DIR "${CMAKE_CURRENT_BINARY_DIR}/crow-async/include")
configure_file("${CMAKE_CURRENT_SOURCE_DIR}/patches/crow-storage-io.h"
               "${DWCUE_CROW_ASYNC_INCLUDE_DIR}/crow/storage_io.h" COPYONLY)
# The public umbrella uses quoted includes relative to itself. Copy it too so
# it cannot mix original and patched definitions of the same template.
configure_file("${DWCUE_CROW_INCLUDE_DIR}/crow.h"
               "${DWCUE_CROW_ASYNC_INCLUDE_DIR}/crow.h" COPYONLY)
set(_crow_headers http_connection.h parser.h http_response.h)
set(_crow_hashes
    fc78d1d6f934b430117984d6ec1dabdb6985aa3edd75c70251d92e89239f4061
    9b9f5c795033859166f9c74cc202868ca37d168113f9edf6a0cf0e337b0b26da
    2fdc48ca11f8150471ecbd734d2fbbf56e1f91836a4d7f25bd184700a1f25e6e)
set(_crow_patched_hashes
    db7ef7e84fb1edc95db23972a96d992774c1ae693a7dce00b9f1871c62437ba3
    77581277621e0a322d66cffa58f642cb33d06fc9f5c44ab4ecec6705ac588fab
    c4505f8a19ca7898b492dd8c3923bd3d808619b61b16b71f1f8dd21bc3c64f64)
foreach(_index RANGE 0 2)
    list(GET _crow_headers ${_index} _header)
    list(GET _crow_hashes ${_index} _expected)
    file(SHA256 "${DWCUE_CROW_INCLUDE_DIR}/crow/${_header}" _actual)
    if(NOT _actual STREQUAL _expected)
        message(FATAL_ERROR "Unsupported Crow ${_header}; review the pinned async HTTP patch before upgrading Crow")
    endif()
    configure_file("${DWCUE_CROW_INCLUDE_DIR}/crow/${_header}"
                   "${DWCUE_CROW_ASYNC_INCLUDE_DIR}/crow/${_header}" COPYONLY)
endforeach()
set(_crow_patch "${CMAKE_CURRENT_SOURCE_DIR}/patches/crow-async-http.patch")
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${_crow_patch}")
file(RELATIVE_PATH _crow_generated_relative "${CMAKE_CURRENT_SOURCE_DIR}/.." "${DWCUE_CROW_ASYNC_INCLUDE_DIR}")
# Keep generated header bytes independent of the host Git line-ending settings.
execute_process(COMMAND "${GIT_EXECUTABLE}" -c core.autocrlf=false apply --unsafe-paths
    --directory "${_crow_generated_relative}" "${_crow_patch}"
    WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/.."
    RESULT_VARIABLE _crow_patch_result ERROR_VARIABLE _crow_patch_error)
if(NOT _crow_patch_result EQUAL 0)
    message(FATAL_ERROR "Crow async HTTP patch failed: ${_crow_patch_error}")
endif()
foreach(_index RANGE 0 2)
    list(GET _crow_headers ${_index} _header)
    list(GET _crow_patched_hashes ${_index} _expected)
    file(SHA256 "${DWCUE_CROW_ASYNC_INCLUDE_DIR}/crow/${_header}" _actual)
    if(NOT _actual STREQUAL _expected)
        message(FATAL_ERROR "Crow async HTTP patch was skipped or changed unexpectedly: ${_header}")
    endif()
endforeach()
configure_file("${CMAKE_CURRENT_SOURCE_DIR}/patches/crow.LICENSE"
               "${DWCUE_CROW_ASYNC_INCLUDE_DIR}/crow/LICENSE" COPYONLY)
