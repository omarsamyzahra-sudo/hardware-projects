# Stand-in for Pod::Usage, which Git for Windows' perl lacks. oss-cad-suite's
# verilator wrapper only uses it to print --help. Use with
#   PERL5LIB=tools/perl5 verilator ...
package Pod::Usage;
use Exporter 'import';
our @EXPORT = ('pod2usage');
sub pod2usage { die "verilator: see --help in the Verilator docs\n" }
1;
