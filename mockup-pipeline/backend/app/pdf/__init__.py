import pypdf

from app.config import get_settings

_STREAM_LIMITS = ("maximum_declared_stream_length", "array_based_stream_maximum_output_length", "lzw_maximum_output_length",
                  "run_length_maximum_output_length", "zlib_maximum_output_length", "image_maximum_buffer_size")


def raise_stream_limits() -> None:
    """pypdf caps each decoded stream at 75 MB (zip-bomb guard); print sheets carry larger images
    (7000 x 4400 px CMYK = 123 MB). The limits live in a ContextVar, so every entry point that reads
    PDFs (job thread, API request, CLI) calls this for its own context."""
    cap = get_settings().pdf_max_stream_mb * 1_000_000
    pypdf.overwrite_configuration(**{f: cap for f in _STREAM_LIMITS})
