"""Regression controls for fixed-pin authentication and bounded nested expansion."""
from pathlib import Path
import argparse
import base64
import gzip
import json
import sys
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True
import common

class MetadataReaderTests(unittest.TestCase):
    def test_original_fixture(self):
        origin, data = common.decode_kernel_metadata(ORIGIN, PACKED)
        self.assertEqual(len(data), 140154)
        self.assertEqual(common.sha(data), origin["metadata"]["sha256"])
        self.assertEqual(json.loads(data)["checkpoint"]["blockNum"], 288)

    def test_raw_hashes_precede_all_decoders(self):
        for origin, packed in [(ORIGIN+b" ",PACKED),(ORIGIN,PACKED+b" ")]:
            with self.subTest(originChanged=origin!=ORIGIN), \
                    patch.object(common,"parsed",side_effect=AssertionError("JSON decoded before authentication")), \
                    patch.object(common.base64,"b64decode",side_effect=AssertionError("Base64 decoded before authentication")), \
                    patch.object(common.gzip,"GzipFile",side_effect=AssertionError("Expanded before authentication")):
                with self.assertRaisesRegex(ValueError,"fixed hash differs"):
                    common.decode_kernel_metadata(origin,packed)

    def test_wrong_pin_bomb_never_opens_gzip(self):
        bomb=base64.b64encode(gzip.compress(b"x"*(1024*1024),mtime=0))
        with patch.object(common.gzip,"GzipFile",side_effect=AssertionError("Unauthenticated gzip opened")):
            with self.assertRaisesRegex(ValueError,"packed fixed hash differs"):
                common.decode_kernel_metadata(ORIGIN,bomb)

    def test_compressed_hash_precedes_gzip(self):
        origin=json.loads(ORIGIN)
        origin["metadata"]["gzipSha256"]="0"*64
        with patch.object(common,"parsed",return_value=origin), \
                patch.object(common.gzip,"GzipFile",side_effect=AssertionError("Compressed hash checked after expansion")):
            with self.assertRaisesRegex(ValueError,"compressed bytes differ"):
                common.decode_kernel_metadata(ORIGIN,PACKED)

    def test_real_overrun_reads_only_expected_plus_one(self):
        compressed=gzip.compress(b"x"*(1024*1024),mtime=0)
        original=common.gzip.GzipFile
        requests=[]
        class ObservedReader:
            def __init__(self,**options):self.reader=original(**options)
            def __enter__(self):return self
            def read(self,size):requests.append(size);return self.reader.read(size)
            def __exit__(self,*_args):self.reader.close()
        with patch.object(common.gzip,"GzipFile",ObservedReader):
            with self.assertRaisesRegex(ValueError,"expanded size differs"):
                common.bounded_gzip_metadata(compressed,8)
        self.assertEqual(requests,[9])

    def test_invalid_size_precedes_gzip(self):
        for size in [0,-1,True,1.5,common.MAX_KERNEL_METADATA+1]:
            with self.subTest(size=size), patch.object(common.gzip,"GzipFile",side_effect=AssertionError("Invalid size opened gzip")):
                with self.assertRaisesRegex(ValueError,"hard bound"):
                    common.bounded_gzip_metadata(b"",size)

    def test_exact_size_is_accepted(self):
        self.assertEqual(common.bounded_gzip_metadata(gzip.compress(b"{}",mtime=0),2),b"{}")

    def test_truncated_stream_is_rejected(self):
        with self.assertRaises((EOFError,OSError,ValueError)):
            common.bounded_gzip_metadata(gzip.compress(b"{}",mtime=0)[:-4],2)

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package",type=Path)
    options=parser.parse_args()
    payload=common.archive_files(options.package/"retained-emission.tar.gz")
    ORIGIN=payload["tests/fixtures/projection-validation/origin.json"]
    PACKED=payload["tests/fixtures/projection-validation/metadata.json.gz.base64"]
    unittest.main(argv=[sys.argv[0]])
